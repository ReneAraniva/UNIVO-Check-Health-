// T-50.1: envía por email las credenciales de un usuario recién creado (Resend).
// Solo ADMIN. Lo invoca UserManagement tras crear el usuario (T-50.2, integración de René).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { getCorsHeaders } from '../_shared/cors.ts';
import { withSentry } from '../_shared/sentry.ts';
import { sendMail, wrapHtml } from '../_shared/mailer.ts';

Deno.serve(withSentry('send-credentials', async (req: Request) => {
  const cors = getCorsHeaders(req);
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status, headers: { ...cors, 'Content-Type': 'application/json' },
    });
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  try {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ error: 'No autorizado' }, 401);

  const userClient = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } },
  );
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return json({ error: 'Sesión inválida' }, 401);

  // ADMIN y DOCENTE pueden crear usuarios (S4-04.2), así que ambos pueden disparar
  // el envío de credenciales del usuario recién creado.
  const { data: profile } = await userClient.from('users').select('role').eq('id', user.id).single();
  const requesterRole = (profile?.role ?? '').toUpperCase();
  if (!['ADMIN', 'ADMINISTRADOR', 'DECANO', 'DOCENTE', 'TEACHER'].includes(requesterRole)) {
    return json({ error: 'No tienes permiso para enviar credenciales.' }, 403);
  }

  const { email, password, full_name, reset } = await req.json().catch(() => ({})) as
    { email?: string; password?: string; full_name?: string; reset?: boolean };
  if (!email || !password) return json({ error: 'email y password requeridos' }, 400);

  const html = reset
    ? wrapHtml(`
      <h2>Tu contraseña fue restablecida</h2>
      <p>Hola ${full_name ?? ''}, un administrador restableció tu contraseña de acceso. Usa esta contraseña temporal para ingresar:</p>
      <div class="cred">
        <p>Usuario (carné o correo): <code>${email}</code></p>
        <p>Contraseña temporal (un solo uso): <code>${password}</code></p>
      </div>
      <p><strong>Por seguridad, esta contraseña es de un solo uso.</strong> Al ingresar, el sistema
      te pedirá crear una contraseña nueva. Si no solicitaste este cambio, contacta a tu coordinación.</p>`)
    : wrapHtml(`
      <h2>Bienvenido/a a UNIVO Check-Health</h2>
      <p>Hola ${full_name ?? ''}, se ha creado tu cuenta institucional. Estas son tus credenciales de acceso:</p>
      <div class="cred">
        <p>Usuario (carné o correo): <code>${email}</code></p>
        <p>Contraseña temporal (un solo uso): <code>${password}</code></p>
      </div>
      <p><strong>Por seguridad, esta contraseña es de un solo uso.</strong> Al ingresar por primera vez,
      el sistema te pedirá crear una contraseña nueva antes de continuar.</p>`);

  const subject = reset
    ? 'Tu contraseña fue restablecida — UNIVO Check-Health'
    : 'Tus credenciales de acceso — UNIVO Check-Health';
  const result = await sendMail({ to: email, subject, html });
  if (!result.ok) {
    const status = result.error === 'missing_gmail_credentials' ? 500 : 502;
    return json({ error: 'No se pudo enviar el correo', detail: result.error }, status);
  }
  return json({ ok: true });
  } catch (e) {
    // Garantiza CORS y un motivo legible ante cualquier excepción inesperada
    // (antes el runtime devolvía un 500 sin CORS = "CORS Missing Allow Origin").
    return json({ error: 'Error interno en send-credentials', detail: e instanceof Error ? e.message : String(e) }, 500);
  }
}));
