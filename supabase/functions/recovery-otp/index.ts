import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { getCorsHeaders } from '../_shared/cors.ts';
import { withSentry } from '../_shared/sentry.ts';
import { sendMail, wrapHtml, type MailResult } from '../_shared/mailer.ts';

const OTP_TTL_MINUTES = 10;
const MAX_ATTEMPTS = 3;
const MAX_REQUESTS_PER_WINDOW = 3;

type RequestBody =
  | { action?: 'request'; email?: string; answer?: string }
  | { action?: 'verify'; email?: string; code?: string };

function normalizeEmail(email: string | undefined): string {
  return (email ?? '').trim().toLowerCase();
}

function makeOtp(): string {
  return String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, '0');
}

function makeSalt(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256(input: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

// Contraseña temporal fuerte (sin caracteres ambiguos). Se exige cambiarla al entrar.
function genTempPassword(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const specials = '!@#$%&*';
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let out = '';
  for (let i = 0; i < 10; i++) out += chars[bytes[i] % chars.length];
  out += specials[bytes[10] % specials.length];
  out += String(bytes[11] % 10);
  return out;
}

async function sendRecoveredCredentialsEmail(to: string | string[], email: string, password: string): Promise<MailResult> {
  const html = wrapHtml(`
    <h2>Tu acceso fue restablecido</h2>
    <p>Verificaste tu identidad correctamente. Usa esta contraseña temporal para ingresar:</p>
    <div class="cred">
      <p>Usuario (carné o correo): <code>${email}</code></p>
      <p>Contraseña temporal (un solo uso): <code>${password}</code></p>
    </div>
    <p><strong>Por seguridad, esta contraseña es de un solo uso.</strong> Al ingresar, el sistema
    te pedirá crear una contraseña nueva. Si no fuiste tú, contacta a tu coordinación.</p>`);
  return await sendMail({ to, subject: 'Tu acceso fue restablecido - UNIVO Check-Health', html });
}

async function sendOtpEmail(to: string | string[], code: string): Promise<MailResult> {
  const html = wrapHtml(`
    <h2>Código de recuperación</h2>
    <p>Usa este código para continuar con la recuperación de acceso. Expira en ${OTP_TTL_MINUTES} minutos.</p>
    <p class="code">${code}</p>
    <p>Si no solicitaste este código, puedes ignorar este correo.</p>`);

  return await sendMail({ to, subject: 'Código de recuperación - UNIVO Check-Health', html });
}

Deno.serve(withSentry('recovery-otp', async (req: Request) => {
  const cors = getCorsHeaders(req);
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Metodo no permitido' }, 405);

  try {
  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const body = await req.json().catch(() => ({})) as RequestBody;
  const email = normalizeEmail(body.email);
  if (!email.endsWith('@univo.edu.sv')) return json({ error: 'Correo institucional invalido.' }, 400);

  if (body.action === 'request') {
    // Q-01 — Rate-limit por IP: frena el spray de correos / fuerza bruta de la
    // respuesta de seguridad desde una misma red (complementa el límite per-email).
    const ip = (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || 'unknown';
    const { data: ipOk } = await admin.rpc('rate_limit_hit', {
      p_bucket: 'otp_request', p_key: ip, p_max: 10, p_window_seconds: 600,
    });
    if (ipOk === false) {
      return json({ error: 'Demasiadas solicitudes desde esta red. Intenta de nuevo más tarde.' }, 429);
    }

    const answer = (body.answer ?? '').trim();
    if (answer.length < 2) return json({ error: 'Respuesta de seguridad requerida.' }, 400);

    const { data: okAnswer, error: answerError } = await admin.rpc('verify_security_answer', {
      p_email: email,
      p_answer: answer,
    });
    if (answerError || okAnswer !== true) return json({ error: 'No se pudo verificar la identidad.' }, 400);

    const { data: user, error: userError } = await admin
      .from('users')
      .select('id, backup_email')
      .eq('email', email)
      .single();
    if (userError || !user) return json({ error: 'No se pudo verificar la identidad.' }, 400);

    // B2: el OTP se envía SIEMPRE al correo institucional y, si existe, también al de
    // respaldo. Antes solo iba al respaldo y, sin respaldo, no llegaba ningún código.
    const recipients = [email];
    if (user.backup_email && user.backup_email.toLowerCase() !== email) {
      recipients.push(user.backup_email);
    }

    const since = new Date(Date.now() - OTP_TTL_MINUTES * 60_000).toISOString();
    const { count } = await admin
      .from('recovery_otps')
      .select('id', { count: 'exact', head: true })
      .eq('email', email)
      .gte('created_at', since);
    if ((count ?? 0) >= MAX_REQUESTS_PER_WINDOW) {
      return json({ error: 'Demasiados codigos solicitados. Intenta de nuevo en 10 minutos.' }, 429);
    }

    const code = makeOtp();
    const salt = makeSalt();
    const otpHash = await sha256(`${code}:${salt}`);
    const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60_000).toISOString();

    await admin
      .from('recovery_otps')
      .update({ consumed_at: new Date().toISOString() })
      .eq('email', email)
      .is('consumed_at', null);

    const { data: inserted, error: insertError } = await admin.from('recovery_otps').insert({
      user_id: user.id,
      email,
      backup_email: user.backup_email ?? email,
      otp_hash: otpHash,
      otp_salt: salt,
      expires_at: expiresAt,
    }).select('id').single();
    if (insertError || !inserted) return json({ error: 'No se pudo generar el codigo.' }, 400);

    // Si el correo no se envía, invalidamos el OTP recién creado y reportamos el
    // fallo de forma explícita (antes se respondía "enviado" aunque fallara).
    const mail = await sendOtpEmail(recipients, code);
    if (!mail.ok) {
      await admin.from('recovery_otps').update({ consumed_at: new Date().toISOString() }).eq('id', inserted.id);
      const status = mail.error === 'missing_gmail_credentials' ? 500 : 502;
      return json({ error: 'No se pudo enviar el código. Intenta más tarde.', detail: mail.error }, status);
    }
    const masked = user.backup_email && user.backup_email.toLowerCase() !== email
      ? 'Código enviado a tu correo institucional y de respaldo.'
      : 'Código enviado a tu correo institucional.';
    return json({ ok: true, message: masked });
  }

  if (body.action === 'verify') {
    const code = (body.code ?? '').trim();
    if (!/^\d{6}$/.test(code)) return json({ error: 'Codigo invalido.' }, 400);

    const { data: otp, error } = await admin
      .from('recovery_otps')
      .select('id, user_id, backup_email, otp_hash, otp_salt, attempts, expires_at')
      .eq('email', email)
      .is('consumed_at', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error || !otp) return json({ error: 'No hay codigo activo.' }, 400);
    if (new Date(otp.expires_at).getTime() < Date.now()) {
      await admin.from('recovery_otps').update({ consumed_at: new Date().toISOString() }).eq('id', otp.id);
      return json({ error: 'El codigo expiro. Solicita uno nuevo.' }, 400);
    }
    if (otp.attempts >= MAX_ATTEMPTS) return json({ error: 'Maximo de intentos alcanzado.' }, 429);

    const candidateHash = await sha256(`${code}:${otp.otp_salt}`);
    if (candidateHash !== otp.otp_hash) {
      const nextAttempts = Math.min(MAX_ATTEMPTS, otp.attempts + 1);
      await admin.from('recovery_otps').update({ attempts: nextAttempts }).eq('id', otp.id);
      return json({ error: `Codigo incorrecto. Intentos restantes: ${MAX_ATTEMPTS - nextAttempts}.` }, 400);
    }

    await admin.from('recovery_otps').update({ consumed_at: new Date().toISOString() }).eq('id', otp.id);

    // El código es válido → se restablece la contraseña a una temporal de un solo
    // uso y se envía por correo (institucional + respaldo). Antes el flujo solo
    // validaba el código y NUNCA entregaba credenciales nuevas: recuperación muerta.
    const newPassword = genTempPassword();
    const { error: pwErr } = await admin.auth.admin.updateUserById(otp.user_id as string, { password: newPassword });
    if (pwErr) {
      return json({ error: 'Código válido, pero no se pudo restablecer la contraseña. Intenta de nuevo o contacta a tu coordinación.' }, 500);
    }
    await admin.from('users').update({ must_change_password: true }).eq('id', otp.user_id);

    const recipients = [email];
    if (otp.backup_email && (otp.backup_email as string).toLowerCase() !== email) {
      recipients.push(otp.backup_email as string);
    }
    const mail = await sendRecoveredCredentialsEmail(recipients, email, newPassword);
    const note = mail.ok
      ? 'Te enviamos una contraseña temporal a tu correo. Revisa también la carpeta de Spam.'
      : 'No se pudo enviar el correo con la contraseña. Contacta a tu coordinación.';
    return json({ ok: true, emailed: mail.ok, message: `Código verificado. ${note}` });
  }

  return json({ error: 'Accion no soportada.' }, 400);
  } catch (e) {
    return json({ error: 'Error interno en recovery-otp', detail: e instanceof Error ? e.message : String(e) }, 500);
  }
}));
