// Fase 2: procesa un item de notification_outbox → FCM HTTP v1 push + Gmail SMTP email
// Invocado por el trigger fn_dispatch_outbox_item vía pg_net.http_post.
// Autenticación: header x-dispatch-secret debe coincidir con DISPATCH_WEBHOOK_SECRET.
// Secrets requeridos en Supabase:
//   DISPATCH_WEBHOOK_SECRET  — secreto compartido con el trigger SQL (fn_dispatch_outbox_item)
//   FCM_SERVICE_ACCOUNT_JSON — JSON de cuenta de servicio Firebase Admin (minificado, 1 línea)
//   GMAIL_USER               — dirección Gmail usada como remitente SMTP
//   GMAIL_APP_PASSWORD       — contraseña de aplicación Gmail (16 chars, requiere 2FA)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { getCorsHeaders } from '../_shared/cors.ts';
import { withSentry } from '../_shared/sentry.ts';
import { sendMail, wrapHtml } from '../_shared/mailer.ts';

// ─────────────────────────────────────────────────────────────────────────────
// FCM HTTP v1 — autenticación con service account (OAuth2 JWT bearer)
// ─────────────────────────────────────────────────────────────────────────────
type ServiceAccount = {
  project_id: string;
  client_email: string;
  private_key: string;
};

async function getGoogleOAuthToken(sa: ServiceAccount): Promise<string> {
  const pemContents = sa.private_key
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\s/g, '');

  const binaryDer = Uint8Array.from(atob(pemContents), (c) => c.charCodeAt(0));

  const privateKey = await crypto.subtle.importKey(
    'pkcs8',
    binaryDer.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const now = Math.floor(Date.now() / 1000);
  const toB64Url = (s: string) =>
    btoa(s).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

  const header  = toB64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = toB64Url(JSON.stringify({
    iss:   sa.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud:   'https://oauth2.googleapis.com/token',
    exp:   now + 3600,
    iat:   now,
  }));

  const input = new TextEncoder().encode(`${header}.${payload}`);
  const sig   = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, input);
  const sigB64 = toB64Url(String.fromCharCode(...new Uint8Array(sig)));

  const jwt = `${header}.${payload}.${sigB64}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:   `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
    signal: AbortSignal.timeout(8000),
  });

  const data = await res.json() as { access_token: string };
  return data.access_token;
}

async function sendFcmPush(token: string, title: string, body: string): Promise<void> {
  const saJson = Deno.env.get('FCM_SERVICE_ACCOUNT_JSON');
  if (!saJson || !token) return;

  const sa = JSON.parse(saJson) as ServiceAccount;
  const accessToken = await getGoogleOAuthToken(sa);

  const res = await fetch(
    `https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`,
    {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        message: {
          token,
          notification: { title, body },
          webpush: {
            notification: { icon: '/favicon.ico', badge: '/favicon.ico' },
          },
        },
      }),
      signal: AbortSignal.timeout(8000),
    },
  );

  if (!res.ok) {
    const errText = await res.text().catch(() => res.statusText);
    throw new Error(`FCM error ${res.status}: ${errText}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Gmail email (SMTP vía _shared/mailer.ts)
// ─────────────────────────────────────────────────────────────────────────────
async function sendEmail(to: string, subject: string, bodyHtml: string): Promise<{ ok: boolean; error?: string }> {
  return await sendMail({ to, subject, html: wrapHtml(bodyHtml) });
}

// ─────────────────────────────────────────────────────────────────────────────
// Plantillas por tipo de notificación
// ─────────────────────────────────────────────────────────────────────────────
type Payload = Record<string, unknown>;

const TEMPLATES: Record<string, {
  title: string;
  pushBody:     (p: Payload) => string;
  emailSubject: (p: Payload) => string;
  emailHtml:    (p: Payload) => string;
}> = {
  COMPLIANCE_ALERT: {
    title:        'Alerta de cumplimiento',
    pushBody:     (p) => `Tu cumplimiento está en ${p.compliance_pct}%, por debajo del ${p.threshold}%.`,
    emailSubject: (p) => `Cumplimiento al ${p.compliance_pct}% — Acción requerida`,
    emailHtml:    (p) => `
      <h2>Alerta de cumplimiento de horas</h2>
      <p>Tu porcentaje de cumplimiento actual es <strong>${p.compliance_pct}%</strong>,
         por debajo del umbral del <strong>${p.threshold}%</strong>.</p>
      <p>Horas completadas: <strong>${p.total_hours}h</strong> de <strong>${p.goal_hours}h</strong>.</p>
      <p>Ingresa al sistema para consultar tu historial.</p>`,
  },
  OMISSION_ALERT: {
    title:        'Omisión de check-out',
    pushBody:     (p) => `Un estudiante lleva ${p.hours_open} h sin registrar salida.`,
    emailSubject: () => 'Check-out omitido — Revisión requerida',
    emailHtml:    (p) => `
      <h2>Omisión de check-out detectada</h2>
      <p>Un estudiante lleva <strong>${p.hours_open} horas</strong> sin registrar salida.</p>
      <p>Ingresa al dashboard del coordinador para revisar el caso.</p>`,
  },
  LOCATION_MISMATCH: {
    title:        'Discrepancia de ubicación',
    pushBody:     () => 'Check-out desde una ubicación distinta al check-in.',
    emailSubject: () => 'Alerta de discrepancia geográfica',
    emailHtml:    (p) => `
      <h2>Check-out desde ubicación diferente al check-in</h2>
      <p>${p.message ?? 'Discrepancia geográfica detectada entre check-in y check-out.'}</p>
      <p>Ingresa al dashboard del coordinador para revisar el registro.</p>`,
  },
  FAKE_GPS_DETECTED: {
    title:        'GPS falso detectado',
    pushBody:     (p) => `Posible GPS falso. Confianza: ${Math.round(((p.confidence as number) ?? 0) * 100)}%.`,
    emailSubject: () => 'Alerta de seguridad: GPS falso',
    emailHtml:    (p) => `
      <h2>Posible emulación de GPS detectada</h2>
      <p>Confianza: <strong>${Math.round(((p.confidence as number) ?? 0) * 100)}%</strong>.</p>
      <p>Ingresa al dashboard del coordinador para revisar la auditoría.</p>`,
  },
  SHARED_DEVICE_ACTIVE_CONFLICT: {
    title:        'Dispositivo compartido',
    pushBody:     () => 'Mismo dispositivo activo en sedes distintas.',
    emailSubject: () => 'Alerta de seguridad: dispositivo compartido',
    emailHtml:    () => `
      <h2>Conflicto de dispositivo entre sedes</h2>
      <p>El mismo dispositivo intentó registrar asistencia en dos sedes distintas simultáneamente.</p>
      <p>El intento fue registrado en auditoría.</p>`,
  },
  CHECKOUT_REMINDER: {
    title:        'Recordatorio de salida',
    pushBody:     (p) => `Llevas ${p.hours_open} h sin marcar tu salida. No olvides registrar tu check-out.`,
    emailSubject: () => 'Recordatorio: registra tu salida — UNIVO Check-Health',
    emailHtml:    (p) => `
      <h2>No olvides marcar tu salida</h2>
      <p>Tienes una jornada abierta desde hace <strong>${p.hours_open} horas</strong> sin registrar check-out.</p>
      <p>Ingresa a la app y marca tu salida para que tus horas se contabilicen correctamente.</p>`,
  },
  JUSTIFICATION_RECEIVED: {
    title:        'Nueva solicitud de justificación',
    pushBody:     (p) => `${p.student_name ?? 'Estudiante'} (${p.student_code ?? ''}) envió una justificación para ${p.campus_name ?? 'su sede'}.`,
    emailSubject: (p) => `Justificación pendiente — ${p.student_name ?? 'Estudiante'} · ${p.attendance_date ?? ''}`,
    emailHtml:    (p) => `
      <h2>Nueva solicitud de justificación</h2>
      <p><strong>${p.student_name ?? 'Un estudiante'}</strong> (${p.student_code ?? ''}) envió una solicitud de justificación.</p>
      <ul>
        <li><strong>Fecha de asistencia:</strong> ${p.attendance_date ?? '—'}</li>
        <li><strong>Sede:</strong> ${p.campus_name ?? '—'}</li>
        <li><strong>Motivo:</strong> ${p.reason ?? '—'}</li>
      </ul>
      <p>Ingresa al panel del coordinador para revisar y aprobar o rechazar la solicitud.</p>`,
  },
  JUSTIFICATION_DECISION: {
    title:        'Justificacion revisada',
    pushBody:     (p) => `Tu justificacion fue ${p.status === 'APROBADO' ? 'aprobada' : 'rechazada'}.`,
    emailSubject: (p) => `Tu justificacion fue ${p.status === 'APROBADO' ? 'aprobada' : 'rechazada'} - UNIVO Check-Health`,
    emailHtml:    (p) => `
      <h2>Resultado de tu justificacion</h2>
      <p>Tu solicitud de justificacion para la asistencia del <strong>${p.attendance_date ?? '-'}</strong>
         en <strong>${p.campus_name ?? 'tu sede'}</strong> fue
         <strong>${p.status === 'APROBADO' ? 'aprobada' : 'rechazada'}</strong>.</p>
      <p><strong>Comentario del revisor:</strong> ${p.reviewer_notes || 'Sin comentario adicional.'}</p>
      <p>Ingresa al sistema para revisar el detalle de tus justificaciones.</p>`,
  },
  CONDUCT_REPORT: {
    title:        'Reporte de conducta',
    pushBody:     (p) => `${p.representative_name ?? 'El representante'} reportó la conducta de ${p.student_name ?? 'un estudiante'} (${p.student_code ?? ''}).`,
    emailSubject: (p) => `Reporte de conducta — ${p.student_name ?? 'Estudiante'} · ${p.campus_name ?? ''}`,
    emailHtml:    (p) => `
      <h2>Reporte de conducta inadecuada</h2>
      <p><strong>${p.representative_name ?? 'El representante de la sede'}</strong> reportó la conducta de
         <strong>${p.student_name ?? 'un estudiante'}</strong> (${p.student_code ?? ''}).</p>
      <ul>
        <li><strong>Sede:</strong> ${p.campus_name ?? '—'}</li>
        <li><strong>Fecha:</strong> ${p.attendance_date ?? '—'}</li>
        <li><strong>Motivo:</strong> ${p.motivo ?? '—'}</li>
      </ul>
      <p>Ingresa al panel para revisar el caso del estudiante.</p>`,
  },
  JUSTIFICATION_ESCALATED: {
    title:        'Justificacion escalada',
    pushBody:     (p) => p.recipient_role === 'teacher'
      ? `${p.student_name ?? 'Un estudiante'} tiene una justificacion escalada para segunda revision.`
      : 'Tu justificacion fue escalada para segunda revision.',
    emailSubject: (p) => p.recipient_role === 'teacher'
      ? `Justificacion escalada - ${p.student_name ?? 'Estudiante'}`
      : 'Tu justificacion fue escalada - UNIVO Check-Health',
    emailHtml:    (p) => p.recipient_role === 'teacher'
      ? `
      <h2>Justificacion escalada para segunda revision</h2>
      <p><strong>${p.student_name ?? 'Un estudiante'}</strong> (${p.student_code ?? ''}) tiene una justificacion escalada.</p>
      <ul>
        <li><strong>Fecha de asistencia:</strong> ${p.attendance_date ?? '-'}</li>
        <li><strong>Sede:</strong> ${p.campus_name ?? 'Sede desconocida'}</li>
        <li><strong>Nota de escalamiento:</strong> ${p.escalation_note ?? 'Sin nota adicional.'}</li>
      </ul>
      <p>Ingresa al panel de justificaciones para revisar el caso.</p>`
      : `
      <h2>Tu justificacion fue escalada</h2>
      <p>Tu solicitud para la asistencia del <strong>${p.attendance_date ?? '-'}</strong>
         en <strong>${p.campus_name ?? 'tu sede'}</strong> fue escalada para segunda revision.</p>
      <p><strong>Nota:</strong> ${p.escalation_note ?? 'Sin nota adicional.'}</p>
      <p>Recibiras una nueva decision cuando el caso sea revisado.</p>`,
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Handler principal
// ─────────────────────────────────────────────────────────────────────────────
Deno.serve(withSentry('notify-dispatcher', async (req: Request) => {
  const cors = getCorsHeaders(req);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  // El secreto compartido viaja en x-dispatch-secret (no en Authorization, que lleva
  // la anon key para pasar el gateway de Edge Functions). Se acepta también el formato
  // antiguo `Authorization: Bearer <secreto>` por retrocompatibilidad.
  const dispatchSecret = req.headers.get('x-dispatch-secret') ?? '';
  const authHeader     = req.headers.get('Authorization') ?? '';
  const expectedSecret = Deno.env.get('DISPATCH_WEBHOOK_SECRET');
  const secretOk = Boolean(expectedSecret) &&
    (dispatchSecret === expectedSecret || authHeader === `Bearer ${expectedSecret}`);
  if (!secretOk) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  const body = await req.json().catch(() => ({})) as { outbox_id?: number };
  if (!body.outbox_id) {
    return new Response(JSON.stringify({ error: 'outbox_id requerido' }), {
      status: 400,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  // Marcar como 'sent' atómicamente para evitar reenvíos
  const { data: item, error: fetchErr } = await admin
    .from('notification_outbox')
    .update({ status: 'sent', sent_at: new Date().toISOString() })
    .eq('id', body.outbox_id)
    .eq('status', 'pending')
    .select()
    .single();

  if (fetchErr || !item) {
    return new Response(JSON.stringify({ skipped: true }), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  const template = TEMPLATES[item.type as string];
  if (!template) {
    return new Response(JSON.stringify({ error: `Tipo desconocido: ${item.type}` }), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  const payload        = (item.payload ?? {}) as Payload;
  const recipientEmail = (payload.recipient_email as string) ?? '';
  const results: string[] = [];

  if (item.channel === 'push') {
    const { data: tokenRow } = await admin
      .from('push_tokens')
      .select('token')
      .eq('user_id', item.target_user_id)
      .single();

    if (tokenRow?.token) {
      try {
        await sendFcmPush(tokenRow.token as string, template.title, template.pushBody(payload));
        results.push('push_sent');
      } catch {
        results.push('push_failed');
        await admin
          .from('notification_outbox')
          .update({ status: 'failed' })
          .eq('id', item.id);
      }
    } else {
      results.push('push_no_token');
      await admin
        .from('notification_outbox')
        .update({ status: 'failed' })
        .eq('id', item.id);
    }
  } else if (item.channel === 'email') {
    const subject = template.emailSubject(payload);
    const html = template.emailHtml(payload);
    const delivery = {
      email_channel_used: null as 'primary' | 'backup' | null,
      primary_email: recipientEmail || null,
      backup_email: null as string | null,
      primary_error: null as string | null,
      backup_error: null as string | null,
    };

    const primaryResult = recipientEmail
      ? await sendEmail(recipientEmail, subject, html)
      : { ok: false, error: 'email_no_address' };

    if (primaryResult.ok) {
      delivery.email_channel_used = 'primary';
      results.push('email_sent_primary');
    } else {
      delivery.primary_error = primaryResult.error ?? 'email_primary_failed';
      const payloadBackupEmail = (payload.backup_email as string | undefined)?.trim() ?? '';
      const { data: userEmailRow } = await admin
        .from('users')
        .select('backup_email')
        .eq('id', item.target_user_id)
        .maybeSingle();
      const backupEmail = payloadBackupEmail || ((userEmailRow?.backup_email as string | null) ?? '');
      delivery.backup_email = backupEmail || null;

      if (backupEmail && backupEmail !== recipientEmail) {
        const backupResult = await sendEmail(backupEmail, subject, html);
        if (backupResult.ok) {
          delivery.email_channel_used = 'backup';
          results.push('email_sent_backup');
        } else {
          delivery.backup_error = backupResult.error ?? 'email_backup_failed';
          results.push('email_failed');
        }
      } else {
        results.push('email_failed_no_backup');
      }
    }

    await admin
      .from('notification_outbox')
      .update({
        status: delivery.email_channel_used ? 'sent' : 'failed',
        payload: { ...payload, delivery },
      })
      .eq('id', item.id);
  }

  return new Response(JSON.stringify({ ok: true, results }), {
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}));
