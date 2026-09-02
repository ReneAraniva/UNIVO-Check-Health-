// T-27.2 / T-35.1: firma digital del reporte consolidado del docente.
// Recibe el hash SHA-256 del PDF (calculado en el cliente, T-27.1 de René) y:
//  - sella con HMAC-SHA256 (sello rápido, doble firma docente + sistema), y
//  - si hay certificado configurado, AÑADE una firma digital X.509 real
//    (RSA-SHA256) sobre el payload del sistema. Todo queda inmutable en audit_log.
// Solo DOCENTE/ADMIN/COORDINATOR.
//
// Secrets para la firma X.509 (opcionales; sin ellos cae al sello HMAC):
//   REPORT_SIGNING_KEY  — clave privada RSA en PEM (PKCS#8).
//   REPORT_SIGNING_CERT — certificado X.509 en PEM (acompaña la firma).
// Generación offline (autofirmado, suficiente para acreditación académica):
//   openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 1825 \
//     -subj "/C=SV/O=UNIVO/CN=UNIVO Check-Health"
//   openssl pkcs8 -topk8 -nocrypt -in key.pem -out key.pk8.pem   # PKCS#8 para Web Crypto

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { getCorsHeaders } from '../_shared/cors.ts';
import { withSentry } from '../_shared/sentry.ts';
import {
  SYSTEM_REPORT_SIGNER_ID,
  SYSTEM_REPORT_SIGNER_NAME,
  buildReportSignaturePayload,
  hmacSeal,
  signRsaSha256,
  certFingerprint,
} from '../_shared/reportSeal.ts';

Deno.serve(withSentry('sign-report', async (req: Request) => {
  const cors = getCorsHeaders(req);
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status, headers: { ...cors, 'Content-Type': 'application/json' },
    });
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ error: 'No autorizado' }, 401);

  const userClient = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } },
  );
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return json({ error: 'Sesión inválida' }, 401);

  const { data: profile } = await userClient.from('users').select('role, full_name').eq('id', user.id).single();
  const role = (profile?.role ?? '').toUpperCase();
  if (!['ADMIN', 'COORDINATOR', 'COORDINADOR', 'TEACHER', 'DOCENTE'].includes(role)) {
    return json({ error: 'No autorizado para firmar reportes.' }, 403);
  }

  const { report_hash, period, group_label } = await req.json().catch(() => ({})) as
    { report_hash?: string; period?: string; group_label?: string };
  if (!report_hash) return json({ error: 'report_hash requerido' }, 400);

  const secret = Deno.env.get('QR_JWT_SECRET'); // reutiliza el secreto server-side
  if (!secret) return json({ error: 'Servidor mal configurado' }, 500);

  const signedAt = new Date().toISOString();
  const teacherPayload = buildReportSignaturePayload({
    reportHash: report_hash,
    role: 'teacher',
    signerId: user.id,
    signedAt,
  });
  const systemPayload = buildReportSignaturePayload({
    reportHash: report_hash,
    role: 'system',
    signerId: SYSTEM_REPORT_SIGNER_ID,
    signedAt,
  });
  const teacherSeal = await hmacSeal(teacherPayload, secret);
  const systemSeal = await hmacSeal(systemPayload, secret);
  const signedBy = profile?.full_name ?? user.email;

  // T-35.1 — Firma digital X.509 real (si hay certificado configurado).
  const signingKey = Deno.env.get('REPORT_SIGNING_KEY');
  const signingCert = Deno.env.get('REPORT_SIGNING_CERT');
  let x509: {
    algorithm: string;
    signature: string;
    cert_fingerprint: string;
    certificate_pem: string;
  } | null = null;
  if (signingKey) {
    try {
      const signature = await signRsaSha256(systemPayload, signingKey);
      x509 = {
        algorithm: 'RSASSA-PKCS1-v1_5-SHA256',
        signature,
        cert_fingerprint: signingCert ? await certFingerprint(signingCert) : '',
        certificate_pem: signingCert ?? '',
      };
    } catch (e) {
      // Configuración inválida no debe tumbar el sellado HMAC; se reporta en logs.
      console.error('Firma X.509 fallida:', e instanceof Error ? e.message : e);
    }
  }
  const signatureAlgorithm = x509 ? 'X509_RSA_SHA256+HMAC_SHA256' : 'HMAC_SHA256';

  // Registro inmutable en audit_log (con service_role para garantizar el insert)
  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
  await admin.from('audit_log').insert({
    action: 'REPORT_SIGNED',
    actor_user_id: user.id,
    details: {
      report_hash, period: period ?? null, group_label: group_label ?? null,
      signed_by: signedBy,
      signed_at: signedAt,
      seal: teacherSeal,
      teacher_seal: teacherSeal,
      system_seal: systemSeal,
      signature_algorithm: signatureAlgorithm,
      x509: x509 ? {
        algorithm: x509.algorithm,
        signature: x509.signature,
        cert_fingerprint: x509.cert_fingerprint,
      } : null,
      signatures: {
        teacher: {
          role: 'teacher',
          signer_id: user.id,
          signed_by: signedBy,
          signed_at: signedAt,
          seal: teacherSeal,
        },
        system: {
          role: 'system',
          signer_id: SYSTEM_REPORT_SIGNER_ID,
          signed_by: SYSTEM_REPORT_SIGNER_NAME,
          signed_at: signedAt,
          seal: systemSeal,
        },
      },
    },
  });

  return json({
    ok: true,
    seal: teacherSeal,
    teacher_seal: teacherSeal,
    system_seal: systemSeal,
    signed_at: signedAt,
    signed_by: signedBy,
    system_signed_by: SYSTEM_REPORT_SIGNER_NAME,
    signature_algorithm: signatureAlgorithm,
    x509: x509 ? {
      algorithm: x509.algorithm,
      signature: x509.signature,
      cert_fingerprint: x509.cert_fingerprint,
      certificate_pem: x509.certificate_pem,
    } : null,
  });
}));
