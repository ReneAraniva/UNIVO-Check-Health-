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

  // Auth: coordinador autenticado O llamada interna con dispatch_webhook_secret
  const webhookSecret = Deno.env.get('DISPATCH_WEBHOOK_SECRET');
  const isInternalCall = webhookSecret && authHeader === `Bearer ${webhookSecret}`;

  let requester: { id: string; role: string } | null = null;

  if (!isInternalCall) {
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

  const body = await req.json().catch(() => ({})) as { campus_id?: string };
  if (!body.campus_id) {
    return new Response(JSON.stringify({ error: 'campus_id requerido' }), {
      status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  if (requester && requester.role !== 'ADMIN') {
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

  if (cached?.token) {
    token = cached.token as string;
    shortCode = (cached.short_code as string) ?? await deriveShortCode(body.campus_id, 'STATIC', qrSecret);
  } else {
    const secretKey = new TextEncoder().encode(qrSecret);
    // Sin setExpirationTime → el token no caduca; la seguridad está en geofence,
    // ventana horaria por alumno e IP, no en la rotación del QR.
    token = await new jose.SignJWT({ campus_id: body.campus_id })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .sign(secretKey);
    shortCode = await deriveShortCode(body.campus_id, 'STATIC', qrSecret);

    await admin.from('campus_qr').upsert(
      { campus_id: body.campus_id, token, short_code: shortCode, updated_at: new Date().toISOString() },
      { onConflict: 'campus_id' },
    );
  }

  const qrDataUrl: string = await QRCode.toDataURL(token, { width: 280, margin: 2, errorCorrectionLevel: 'M' });

  return new Response(
    JSON.stringify({ token, short_code: shortCode, qr_data_url: qrDataUrl, static: true }),
    { headers: { ...cors, 'Content-Type': 'application/json' } },
  );
}));
