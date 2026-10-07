import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import * as jose from 'https://esm.sh/jose@5';
import QRCode from 'npm:qrcode';
import { getCorsHeaders } from '../_shared/cors.ts';
import { withSentry } from '../_shared/sentry.ts';
import { deriveShortCode } from '../_shared/qr_utils.ts';

function normalizeRole(raw: string | null | undefined): string {
  const role = (raw ?? '').toUpperCase().trim();
  if (role === 'ADMINISTRADOR' || role === 'DECANO') return 'ADMIN';
  if (role === 'TEACHER') return 'DOCENTE';
  if (role === 'COORDINATOR') return 'COORDINADOR';
  return role;
}

Deno.serve(withSentry('generate-campus-qr', async (req: Request) => {
  const cors = getCorsHeaders(req);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  const authHeader = req.headers.get('Authorization') ?? '';
  if (!authHeader) {
    return new Response(JSON.stringify({ error: 'No autorizado' }), {
      status: 401, headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  // Auth: solo staff autenticado. La antigua "llamada interna" con
  // DISPATCH_WEBHOOK_SECRET era del cron generate-daily-qrs (desprogramado desde la
  // Fase 3) y reutilizaba el secreto del dispatcher como bearer: se eliminó.
  let requester: { id: string; role: string };
  {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return new Response(JSON.stringify({ error: 'No autorizado' }), {
        status: 401, headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }
    const { data: userData } = await supabase.from('users').select('role').eq('id', user.id).single();
    const role = normalizeRole(userData?.role);
    if (!['ADMIN', 'COORDINADOR', 'DOCENTE'].includes(role)) {
      return new Response(JSON.stringify({ error: 'No tienes permiso para generar el QR de la sede.' }), {
        status: 403, headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }
    requester = { id: user.id, role };
  }

  const body = await req.json().catch(() => ({})) as { campus_id?: string; regenerate?: boolean };
  if (!body.campus_id) {
    return new Response(JSON.stringify({ error: 'campus_id requerido' }), {
      status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  if (requester.role !== 'ADMIN') {
    const column = requester.role === 'COORDINADOR' ? 'coordinator_id' : 'teacher_id';
    const { data: assignment } = await admin
      .from('teacher_groups')
      .select('id')
      .eq(column, requester.id)
      .eq('campus_id', body.campus_id)
      .limit(1)
      .maybeSingle();

    if (!assignment) {
      return new Response(JSON.stringify({ error: 'Solo puedes generar el QR de tus sedes asignadas.' }), {
        status: 403, headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }
  }

  const qrSecret = Deno.env.get('QR_JWT_SECRET');
  if (!qrSecret) {
    return new Response(JSON.stringify({ error: 'QR_JWT_SECRET no configurado' }), {
      status: 500, headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  // QR ESTÁTICO: un token por sede, sin fecha ni expiración → se imprime y se reutiliza.
  // Se sirve desde campus_qr si ya existe, para que el QR impreso siga siendo válido.
  const { data: cached } = await admin
    .from('campus_qr')
    .select('token, short_code')
    .eq('campus_id', body.campus_id)
    .single();

  let token: string;
  let shortCode: string;

  // M-7 (auditoría 2026-10-06): regenerar revoca el QR y el código anteriores —
  // validate-qr-checkin solo acepta el token y el código guardados en campus_qr.
  // Útil si una foto del QR se filtró; antes la única salida era rotar
  // QR_JWT_SECRET, que invalidaba TODAS las sedes.
  if (cached?.token && !body.regenerate) {
    token = cached.token as string;
    shortCode = (cached.short_code as string) ?? await deriveShortCode(body.campus_id, 'STATIC', qrSecret);
  } else {
    const secretKey = new TextEncoder().encode(qrSecret);
    // Sin setExpirationTime → el token no caduca; la seguridad está en geofence,
    // ventana horaria por alumno e IP, no en la rotación del QR.
    token = await new jose.SignJWT({ campus_id: body.campus_id })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setJti(crypto.randomUUID())
      .sign(secretKey);
    // Primera generación: código determinista (compatibilidad con los ya impresos).
    // Regeneración: código nuevo, para que el anterior deje de servir.
    shortCode = await deriveShortCode(body.campus_id, cached?.token ? crypto.randomUUID() : 'STATIC', qrSecret);

    const { error: saveError } = await admin.from('campus_qr').upsert(
      { campus_id: body.campus_id, token, short_code: shortCode, updated_at: new Date().toISOString() },
      { onConflict: 'campus_id' },
    );
    if (saveError) {
      return new Response(JSON.stringify({ error: 'No se pudo guardar el QR de la sede.' }), {
        status: 500, headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    if (cached?.token) {
      await admin.from('audit_log').insert({
        action: 'CAMPUS_QR_REGENERATED',
        actor_user_id: requester.id,
        details: { campus_id: body.campus_id, actor_role: requester.role },
      });
    }
  }

  const qrDataUrl: string = await QRCode.toDataURL(token, { width: 280, margin: 2, errorCorrectionLevel: 'M' });

  return new Response(
    JSON.stringify({ token, short_code: shortCode, qr_data_url: qrDataUrl, static: true }),
    { headers: { ...cors, 'Content-Type': 'application/json' } },
  );
}));
