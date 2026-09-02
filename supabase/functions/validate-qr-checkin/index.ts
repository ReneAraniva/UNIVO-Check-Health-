// Validates static campus QR/manual code, GPS, geofence, student schedule,
// anti-fraud signals and registers a server-time check-in.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import * as jose from 'https://esm.sh/jose@5';
import { getCorsHeaders } from '../_shared/cors.ts';
import { withSentry } from '../_shared/sentry.ts';

const ACCURACY_MAX_METERS = 100;

// Solo expone el detalle crudo de Postgres al cliente si CHECKIN_DEBUG=true (para
// depurar). Por defecto, mensajes genéricos (no filtrar internals al usuario final).
const DEBUG = Deno.env.get('CHECKIN_DEBUG') === 'true';

type RequestBody = {
  qr_token?: string;
  short_code?: string;
  campus_id?: string;
  subject_id?: string;
  lat?: number;
  lng?: number;
  accuracy?: number;
  device_fingerprint?: string;
  device_info?: Record<string, unknown>;
};

type AssignmentCandidate = {
  id: string;
  subject_id: string | null;
  period: string;
  start_date: string | null;
  end_date: string | null;
  subject?: { id: string; code: string | null; name: string | null } | null;
};

type ScheduleSlot = {
  assignment_id: string;
  check_in_from: string | null;
  check_in_to: string | null;
};

Deno.serve(withSentry('validate-qr-checkin', async (req: Request) => {
  const cors = getCorsHeaders(req);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  const fail = (message: string, status = 200) => json({ ok: false, message }, status);

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return fail('Sesion no encontrada. Vuelve a iniciar sesion.', 401);

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } },
  );
  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return fail('Sesion no encontrada. Vuelve a iniciar sesion.', 401);

  // Q-01 — Rate-limit por alumno (no por IP: un campus con un solo wifi/NAT
  // bloquearía a todos). 10 intentos/min absorbe reintentos legítimos (GPS/horario)
  // y frena fuerza bruta o scripts de abuso.
  const { data: rlOk } = await admin.rpc('rate_limit_hit', {
    p_bucket: 'checkin', p_key: user.id, p_max: 10, p_window_seconds: 60,
  });
  if (rlOk === false) {
    return fail('Demasiados intentos de registro. Espera un minuto e inténtalo de nuevo.', 429);
  }

  const body = await req.json().catch(() => ({})) as RequestBody;
  const { qr_token, short_code, campus_id: bodyCampusId, subject_id, lat, lng, accuracy, device_fingerprint, device_info } = body;

  if (lat == null || lng == null) return fail('Faltan parametros requeridos (lat, lng).');
  if (!qr_token && (!short_code || !bodyCampusId)) {
    return fail('Proporciona qr_token o (short_code + campus_id).');
  }
  if (accuracy != null && accuracy > ACCURACY_MAX_METERS) {
    return fail(`Senal GPS imprecisa (+/-${Math.round(accuracy)} m). Sal al exterior o activa ubicacion de alta precision e intentalo de nuevo.`);
  }

  const qrSecret = Deno.env.get('QR_JWT_SECRET');
  if (!qrSecret) return fail('Servidor mal configurado.', 500);
  const secretKey = new TextEncoder().encode(qrSecret);

  let campusId: string;
  if (short_code && bodyCampusId) {
    const { data: cached } = await admin
      .from('campus_qr')
      .select('token')
      .eq('campus_id', bodyCampusId)
      .eq('short_code', short_code.toUpperCase())
      .single();
    if (!cached?.token) return fail('Codigo incorrecto. Verifica las 6 letras o pidelo al encargado.');
    try {
      const { payload } = await jose.jwtVerify(cached.token as string, secretKey, { algorithms: ['HS256'] });
      campusId = (payload as { campus_id: string }).campus_id;
    } catch {
      return fail('Codigo invalido. Pidele al encargado que regenere el QR.');
    }
  } else {
    try {
      const { payload } = await jose.jwtVerify(qr_token!, secretKey, { algorithms: ['HS256'] });
      campusId = (payload as { campus_id: string }).campus_id;
    } catch {
      return fail('QR invalido. Pidele al encargado que regenere el QR de la sede.');
    }
  }

  const { data: validationData, error: validationError } = await supabase.rpc('validate_checkin_area', {
    p_campus_id: campusId,
    p_current_lat: lat,
    p_current_lng: lng,
  });
  if (validationError) {
    return fail(DEBUG
      ? `Error al validar ubicacion: ${validationError.message ?? 'desconocido'}`
      : 'No se pudo validar tu ubicacion. Intenta de nuevo en un momento.');
  }
  if (!validationData?.[0]?.is_allowed) {
    return fail(validationData?.[0]?.message ?? 'Ubicacion fuera del area permitida.');
  }

  const assignment = await resolveAssignment({
    admin,
    userId: user.id,
    campusId,
    subjectId: subject_id,
  });
  if (!assignment.ok) return json(assignment.body);

  const { data: activeRecords } = await admin
    .from('attendances')
    .select('id')
    .eq('student_id', user.id)
    .is('check_out', null);
  if (activeRecords && activeRecords.length > 0) return fail('Ya tienes una entrada activa.');

  if (device_fingerprint) {
    const { data: conflict } = await admin.rpc('detect_device_fingerprint_conflict', {
      p_device_fingerprint: device_fingerprint,
      p_campus_id: campusId,
      p_student_id: user.id,
    });
    if (conflict?.[0]) {
      await admin.from('audit_log').insert({
        action: 'SHARED_DEVICE_ACTIVE_CONFLICT',
        actor_user_id: user.id,
        target_user_id: conflict[0].student_id,
        details: {
          attempted_campus_id: campusId,
          active_campus_id: conflict[0].campus_id,
          active_attendance_id: conflict[0].attendance_id,
          device_fingerprint,
        },
      });
      return fail('Dispositivo ya activo en otra sede. El intento fue enviado a auditoria.');
    }
  }

  const isFakeGps = device_info?.isFakeGps === true;
  const confidence = (device_info?.fakeGpsConfidence as number) ?? 0;
  const reasons = ((device_info?.fakeGpsAnalysis as Record<string, unknown>)?.reasons as string[]) ?? [];
  const fakeGpsReason = isFakeGps
    ? `Posible GPS falso detectado (${Math.round(confidence * 100)}%): ${reasons.join(' ')}`
    : undefined;

  if (isFakeGps) {
    await admin.from('audit_log').insert({
      action: 'FAKE_GPS_DETECTED',
      actor_user_id: user.id,
      details: { campus_id: campusId, confidence, lat, lng },
    });
  }

  const { ip: clientIp, info: ipInfo } = await resolveClientIp(req);
  const { data: attendance, error: insertError } = await admin
    .from('attendances')
    .insert({
      student_id: user.id,
      campus_id: campusId,
      assignment_id: assignment.assignmentId,
      subject_id: assignment.subjectId,
      check_in_location: { latitude: lat, longitude: lng, accuracyMeters: accuracy ?? null },
      check_in_ip: clientIp,
      check_in_ip_info: ipInfo,
      device_fingerprint: device_fingerprint ?? null,
      device_info: device_info ?? null,
      review_status: fakeGpsReason ? 'OBSERVADO' : 'PENDIENTE',
      suspicious_reason: fakeGpsReason ?? null,
      status: 'present',
    })
    .select('id')
    .single();

  if (insertError || !attendance) {
    return fail(DEBUG
      ? `Error al registrar la asistencia: ${insertError?.message ?? 'desconocido'}`
      : 'No se pudo registrar la asistencia. Intenta de nuevo.');
  }

  return json({
    ok: true,
    message: 'Entrada registrada con hora oficial del servidor.',
    attendanceId: (attendance as Record<string, unknown>).id,
  });
}));

async function resolveAssignment(params: {
  admin: ReturnType<typeof createClient>;
  userId: string;
  campusId: string;
  subjectId?: string;
}): Promise<
  | { ok: true; assignmentId: string | null; subjectId: string | null }
  | { ok: false; body: Record<string, unknown> }
> {
  const { data: assigns } = await params.admin
    .from('teacher_groups')
    .select('id, subject_id, period, start_date, end_date, subject:subjects(id, code, name)')
    .eq('student_id', params.userId)
    .eq('campus_id', params.campusId);

  if (!assigns || assigns.length === 0) {
    return { ok: true, assignmentId: null, subjectId: null };
  }

  const today = todayDateSV();
  const currentAssignments = (assigns as AssignmentCandidate[])
    .filter((a) => (!a.start_date || a.start_date <= today) && (!a.end_date || a.end_date >= today));
  if (currentAssignments.length === 0) {
    return { ok: false, body: { ok: false, message: 'No tienes una asignacion vigente en esta sede.' } };
  }

  const { data: slots } = await params.admin
    .from('student_schedules')
    .select('assignment_id, check_in_from, check_in_to')
    .in('assignment_id', currentAssignments.map((a) => a.id))
    .eq('weekday', nowIsoWeekday())
    .eq('is_active', true);

  if (!slots || slots.length === 0) {
    return { ok: false, body: { ok: false, message: 'No tienes practica programada hoy en esta sede.' } };
  }

  const cur = nowHourMinuteSV();
  const matchingSlots = (slots as ScheduleSlot[]).filter((s) => {
    const from = (s.check_in_from ?? '').slice(0, 5);
    const to = (s.check_in_to ?? '').slice(0, 5);
    // Turno nocturno: si la salida es "menor" que la entrada (p. ej. 21:00 -> 03:00),
    // la ventana cruza medianoche, asi que el horario valido es cur >= from O cur <= to.
    return from <= to ? cur >= from && cur <= to : cur >= from || cur <= to;
  });

  if (matchingSlots.length === 0) {
    const first = slots[0] as ScheduleSlot;
    return {
      ok: false,
      body: {
        ok: false,
        message: `Fuera de tu horario de hoy (${(first.check_in_from ?? '').slice(0, 5)}-${(first.check_in_to ?? '').slice(0, 5)}).`,
      },
    };
  }

  const bySchedule = currentAssignments.filter((a) => matchingSlots.some((s) => s.assignment_id === a.id));
  const bySubject = params.subjectId ? bySchedule.filter((a) => a.subject_id === params.subjectId) : bySchedule;
  if (bySubject.length === 0) {
    return { ok: false, body: { ok: false, message: 'La materia seleccionada no coincide con tu horario vigente en esta sede.' } };
  }

  const uniqueSubjects = new Map(bySubject.map((a) => [a.subject_id ?? a.id, a]));
  if (!params.subjectId && uniqueSubjects.size > 1) {
    return {
      ok: false,
      body: {
        ok: false,
        requires_subject_choice: true,
        message: 'Tienes varias materias activas en esta sede. Selecciona la materia para registrar la entrada.',
        assignments: [...uniqueSubjects.values()].map((a) => ({
          assignment_id: a.id,
          subject_id: a.subject_id,
          subject_name: a.subject?.name ?? 'Materia sin nombre',
          subject_code: a.subject?.code ?? null,
        })),
      },
    };
  }

  return {
    ok: true,
    assignmentId: bySubject[0].id,
    subjectId: bySubject[0].subject_id ?? null,
  };
}

function nowHourMinuteSV(): string {
  const sv = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/El_Salvador' }));
  return `${String(sv.getHours()).padStart(2, '0')}:${String(sv.getMinutes()).padStart(2, '0')}`;
}

function nowIsoWeekday(): number {
  const sv = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/El_Salvador' }));
  return ((sv.getDay() + 6) % 7) + 1;
}

function todayDateSV(): string {
  const sv = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/El_Salvador' }));
  return `${sv.getFullYear()}-${String(sv.getMonth() + 1).padStart(2, '0')}-${String(sv.getDate()).padStart(2, '0')}`;
}

async function resolveClientIp(req: Request): Promise<{ ip: string | null; info: unknown }> {
  const fwd = req.headers.get('x-forwarded-for') ?? '';
  const ip = fwd.split(',')[0].trim() || null;
  if (!ip) return { ip: null, info: null };
  try {
    const res = await fetch(`https://ip.guide/${ip}`, { signal: AbortSignal.timeout(2500) });
    if (res.ok) return { ip, info: await res.json() };
  } catch {
    // Best effort.
  }
  return { ip, info: null };
}
