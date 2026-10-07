import { supabase } from './supabaseClient';
import { Attendance, GeoPoint } from '@/modules/attendance/types';
import { DeviceInfo } from '@/modules/attendance/types';

type SiteCoverage = GeoPoint & { radiusMeters: number; name?: string };

type ActiveStudentRecord = {
  studentId: string;
  studentName: string;
  carnet: string;
  career: string;
  practiceId: string;
  siteName: string;
  checkIn: string;
  hoursToday: number;
  totalCycleHours: number;
  lastLocation?: GeoPoint;
};

type AttendanceResult = {
  ok: boolean;
  attendance?: Attendance;
  message: string;
};

const EARTH_RADIUS_METERS = 6371000;
const MAX_HUMAN_SPEED_KMH = 140;
const REQUIRED_PRACTICE_HOURS = 240;
const FAKE_GPS_CONFIDENCE_THRESHOLD = 0.8;

const toRadians = (degrees: number) => degrees * (Math.PI / 180);

const distanceInMeters = (from: GeoPoint, to: GeoPoint) => {
  const latitudeDistance = toRadians(to.latitude - from.latitude);
  const longitudeDistance = toRadians(to.longitude - from.longitude);
  const startLatitude = toRadians(from.latitude);
  const endLatitude = toRadians(to.latitude);
  const haversine =
    Math.sin(latitudeDistance / 2) ** 2 +
    Math.cos(startLatitude) * Math.cos(endLatitude) * Math.sin(longitudeDistance / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
};

const variance = (values: number[]) => {
  if (values.length < 2) return 0;
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  return values.reduce((sum, value) => sum + (value - average) ** 2, 0) / values.length;
};

export const analyzeFakeGpsPattern = (deviceInfo: DeviceInfo | undefined): DeviceInfo | undefined => {
  if (!deviceInfo) return undefined;

  const motionSamples = deviceInfo.motionSamples ?? [];
  const locationSamples = deviceInfo.locationSamples ?? [];
  const accelerationVariance = variance(motionSamples.map((sample) => sample.accelerationMagnitude));
  const rotationVariance = variance(motionSamples.map((sample) => sample.rotationRateMagnitude));
  const gpsDriftMeters = locationSamples.reduce((total, sample, index) => {
    const previous = locationSamples[index - 1];
    return previous ? total + distanceInMeters(previous, sample) : total;
  }, 0);

  const reasons: string[] = [];
  let confidence = 0;

  if (motionSamples.length >= 8 && accelerationVariance < 0.0004 && rotationVariance < 0.0004) {
    confidence += 0.45;
    reasons.push('Sensores de movimiento casi planos durante la captura.');
  }

  if (locationSamples.length >= 2 && gpsDriftMeters >= 25) {
    confidence += 0.35;
    reasons.push(`GPS cambio ${Math.round(gpsDriftMeters)} m durante la captura.`);
  }

  if (deviceInfo.gpsAccuracy !== null && deviceInfo.gpsAccuracy <= 5 && motionSamples.length >= 8) {
    confidence += 0.15;
    reasons.push('Precision GPS inusualmente alta para una lectura sin movimiento.');
  }

  if (locationSamples.length >= 2 && motionSamples.length === 0 && deviceInfo.gpsAccuracy !== null && deviceInfo.gpsAccuracy <= 5) {
    confidence += 0.2;
    reasons.push('GPS preciso sin muestras de acelerometro disponibles.');
  }

  const normalizedConfidence = Number(Math.min(confidence, 1).toFixed(2));
  const isFakeGps = normalizedConfidence > FAKE_GPS_CONFIDENCE_THRESHOLD;
  const fakeGpsAnalysis = {
    isFakeGps,
    confidence: normalizedConfidence,
    reasons,
    sampleCount: motionSamples.length,
    gpsDriftMeters: Number(gpsDriftMeters.toFixed(2)),
    accelerationVariance: Number(accelerationVariance.toFixed(6)),
    rotationVariance: Number(rotationVariance.toFixed(6)),
  };

  return {
    ...deviceInfo,
    fakeGpsAnalysis,
    isFakeGps,
    fakeGpsConfidence: normalizedConfidence,
  };
};

const mapAttendanceRow = (row: Record<string, unknown>): Attendance => ({
  id: row.id as string,
  studentId: row.student_id as string,
  practiceId: row.campus_id as string,
  checkIn: row.check_in as string,
  checkOut: (row.check_out as string) ?? undefined,
  date: row.date as string,
  status: row.status as Attendance['status'],
  notes: (row.notes as string) ?? undefined,
  checkInLocation: (row.check_in_location as GeoPoint) ?? undefined,
  checkOutLocation: (row.check_out_location as GeoPoint) ?? undefined,
  securitySeal: (row.security_seal as string) ?? undefined,
  checkOutSecuritySeal: (row.check_out_security_seal as string) ?? undefined,
  workedHours: (row.worked_hours as number) ?? undefined,
  reviewStatus: (row.review_status as Attendance['reviewStatus']) ?? undefined,
  suspiciousReason: (row.suspicious_reason as string) ?? undefined,
  deviceId: (row.device_id as string) ?? undefined,
  deviceFingerprint: (row.device_fingerprint as string) ?? undefined,
  deviceInfo: (row.device_info as DeviceInfo) ?? undefined,
});

const getCampusById = async (campusId: string): Promise<SiteCoverage | null> => {
  const { data, error } = await supabase
    .from('campuses')
    .select('id, latitude, longitude, radius_meters, name')
    .eq('id', campusId)
    .single();

  if (error || !data) return null;

  return {
    latitude: Number(data.latitude),
    longitude: Number(data.longitude),
    radiusMeters: Number(data.radius_meters),
    name: (data.name as string) ?? undefined,
  };
};

// Auditoría 2026-10-06: la entrada manual del encargado y la salida (alumno o staff)
// ya no escriben attendances desde el navegador. Antes:
//   · la salida del alumno hacía UPDATE directo, que la RLS bloquea (0 filas): la
//     jornada quedaba abierta y el siguiente check-in fallaba;
//   · check_out y worked_hours salían del reloj del cliente;
//   · la entrada del encargado hacía INSERT directo sin política para staff.
// Ahora son RPC SECURITY DEFINER (staff_register_check_in / register_check_out) con
// la hora del servidor y las mismas validaciones que validate-qr-checkin. La
// detección de GPS falso sigue calculándose aquí y viaja en device_info.
type RpcAttendanceResult = { ok: boolean; message: string; attendance?: Record<string, unknown> };

const toAttendanceResult = (
  data: unknown,
  error: { message?: string } | null,
  fallback: string,
): AttendanceResult => {
  if (error || !data) {
    return { ok: false, message: error?.message ?? fallback };
  }
  const result = data as RpcAttendanceResult;
  return {
    ok: result.ok,
    message: result.message,
    attendance: result.ok && result.attendance ? mapAttendanceRow(result.attendance) : undefined,
  };
};

export const registerStudentCheckIn = async (params: {
  studentId: string;
  practiceId: string;
  location: GeoPoint;
  notes?: string;
  deviceId?: string;
  deviceFingerprint?: string;
  deviceInfo?: DeviceInfo;
}): Promise<AttendanceResult> => {
  const deviceInfo = analyzeFakeGpsPattern(params.deviceInfo);
  const { data, error } = await supabase.rpc('staff_register_check_in', {
    p_student_id: params.studentId,
    p_campus_id: params.practiceId,
    p_lat: params.location.latitude,
    p_lng: params.location.longitude,
    p_notes: params.notes ?? null,
    p_device_id: params.deviceId ?? null,
    p_device_fingerprint: params.deviceFingerprint ?? null,
    p_device_info: deviceInfo ?? null,
  });
  return toAttendanceResult(data, error, 'Error al registrar la asistencia.');
};

export const registerStudentCheckOut = async (params: {
  attendanceId: string;
  location: GeoPoint;
  deviceId?: string;
  deviceFingerprint?: string;
  deviceInfo?: DeviceInfo;
}): Promise<AttendanceResult> => {
  const deviceInfo = analyzeFakeGpsPattern(params.deviceInfo);
  const { data, error } = await supabase.rpc('register_check_out', {
    p_attendance_id: params.attendanceId,
    p_lat: params.location.latitude,
    p_lng: params.location.longitude,
    p_accuracy: params.location.accuracyMeters ?? deviceInfo?.gpsAccuracy ?? null,
    p_device_id: params.deviceId ?? null,
    p_device_fingerprint: params.deviceFingerprint ?? null,
    p_device_info: deviceInfo ?? null,
  });
  return toAttendanceResult(data, error, 'Error al registrar la salida.');
};

export const getActiveStudentsSnapshot = async (): Promise<ActiveStudentRecord[]> => {
  const [attendancesResult, usersResult, campusesResult] = await Promise.all([
    supabase.from('attendances').select('*').is('check_out', null),
    supabase.from('users').select('id, full_name, career, student_code').eq('role', 'STUDENT'),
    supabase.from('campuses').select('id, name, location_label'),
  ]);

  if (attendancesResult.error || !attendancesResult.data) return [];

  const students = usersResult.data ?? [];
  const campuses = campusesResult.data ?? [];
  const now = Date.now();

  return attendancesResult.data.map((row) => {
    const student = students.find((s) => s.id === row.student_id);
    const campus = campuses.find((c) => c.id === row.campus_id);
    return {
      studentId: row.student_id as string,
      studentName: (student?.full_name as string) ?? 'Desconocido',
      carnet: (student?.student_code as string) ?? '',
      career: (student?.career as string) ?? 'Sin carrera',
      practiceId: row.campus_id as string,
      siteName: (campus?.location_label as string) ?? (campus?.name as string) ?? 'Sede no registrada',
      checkIn: row.check_in as string,
      hoursToday: Number(((now - new Date(row.check_in as string).getTime()) / (1000 * 60 * 60)).toFixed(2)),
      totalCycleHours: 0,
      lastLocation: (row.check_out_location ?? row.check_in_location) as GeoPoint | undefined,
    };
  });
};

// Validación manual de una asistencia observada (OBSERVADO → VALIDADO). La RLS
// `attendances_coordinator_update` la restringe a ADMIN/COORDINATOR server-side.
// El `.eq('review_status', 'OBSERVADO')` la hace idempotente: solo valida observadas.
export const validateAttendance = async (
  attendanceId: string,
): Promise<{ ok: boolean; message?: string }> => {
  const { error } = await supabase
    .from('attendances')
    .update({ review_status: 'VALIDADO' })
    .eq('id', attendanceId)
    .eq('review_status', 'OBSERVADO');
  if (error) return { ok: false, message: error.message };
  return { ok: true };
};

export const getStudentHoursProgress = async (
  studentId: string,
): Promise<{ completedHours: number; requiredHours: number }> => {
  const { data } = await supabase
    .from('attendances')
    .select('worked_hours, check_in, check_out')
    .eq('student_id', studentId);

  let completed = 0;
  if (data) {
    for (const row of data) {
      if (row.worked_hours != null) {
        completed += Number(row.worked_hours);
      } else if (!row.check_out) {
        completed += (Date.now() - new Date(row.check_in as string).getTime()) / (1000 * 60 * 60);
      }
    }
  }

  return { completedHours: Number(completed.toFixed(1)), requiredHours: REQUIRED_PRACTICE_HOURS };
};

// S4-02.4 — Progreso por materia. Las horas se atribuyen vía attendances.subject_id
// (poblado por validate-qr-checkin / S4-02.3). Las horas requeridas siguen la
// precedencia asignación → materia → 240 (misma que close_due_cycles).
export type SubjectProgress = {
  subjectId: string;
  subjectName: string;
  subjectCode: string | null;
  completedHours: number;
  requiredHours: number;
};

export const getStudentSubjectProgress = async (
  studentId: string,
): Promise<SubjectProgress[]> => {
  const [{ data: groups }, { data: attendances }] = await Promise.all([
    supabase
      .from('teacher_groups')
      .select('subject_id, required_hours, subject:subjects(name, code, required_hours)')
      .eq('student_id', studentId)
      .not('subject_id', 'is', null),
    supabase
      .from('attendances')
      .select('worked_hours, check_in, check_out, subject_id')
      .eq('student_id', studentId)
      .not('subject_id', 'is', null),
  ]);

  if (!groups || groups.length === 0) return [];

  // Horas completadas por materia (worked_hours, o tiempo vivo si no hay check-out).
  const completedBySubject = new Map<string, number>();
  for (const row of (attendances ?? []) as Record<string, unknown>[]) {
    const sid = row.subject_id as string | null;
    if (!sid) continue;
    let hours = 0;
    if (row.worked_hours != null) hours = Number(row.worked_hours);
    else if (!row.check_out) hours = (Date.now() - new Date(row.check_in as string).getTime()) / (1000 * 60 * 60);
    completedBySubject.set(sid, (completedBySubject.get(sid) ?? 0) + hours);
  }

  // Horas requeridas por materia: el override de asignación tiene prioridad; si
  // hay varias asignaciones de la misma materia, se queda con el menor override
  // definido (la rotación más exigente ya cubierta) o las horas de la materia.
  type GroupRow = {
    subject_id: string;
    required_hours: number | null;
    subject: { name: string | null; code: string | null; required_hours: number | null } | null;
  };
  const bySubject = new Map<string, { name: string; code: string | null; required: number }>();
  for (const g of (groups as unknown as GroupRow[])) {
    const sid = g.subject_id;
    const subjectRequired = g.subject?.required_hours ?? REQUIRED_PRACTICE_HOURS;
    const required = g.required_hours ?? subjectRequired;
    const existing = bySubject.get(sid);
    if (!existing) {
      bySubject.set(sid, {
        name: g.subject?.name ?? 'Materia',
        code: g.subject?.code ?? null,
        required,
      });
    } else if (required > existing.required) {
      existing.required = required;
    }
  }

  return [...bySubject.entries()]
    .map(([subjectId, v]) => ({
      subjectId,
      subjectName: v.name,
      subjectCode: v.code,
      completedHours: Number((completedBySubject.get(subjectId) ?? 0).toFixed(1)),
      requiredHours: v.required,
    }))
    .sort((a, b) => a.subjectName.localeCompare(b.subjectName));
};

export const checkLocationVsPractice = async (
  practiceId: string,
  location: GeoPoint,
): Promise<{ distance: number; isInside: boolean; radiusMeters: number; center: GeoPoint }> => {
  const campus = await getCampusById(practiceId);
  if (!campus) {
    return { distance: Infinity, isInside: false, radiusMeters: 100, center: location };
  }
  const distance = distanceInMeters(location, campus);
  const tolerance = location.accuracyMeters ?? 0;
  return {
    distance: Math.round(distance),
    isInside: distance <= campus.radiusMeters + tolerance,
    radiusMeters: campus.radiusMeters,
    center: { latitude: campus.latitude, longitude: campus.longitude },
  };
};
