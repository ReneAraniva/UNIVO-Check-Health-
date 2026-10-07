import { supabase } from '@/shared/backend/supabaseClient';
import { reportServiceError } from '@/shared/utils/sentry';

const JUSTIFICATION_BUCKET = 'justifications';
const SIGNED_URL_TTL_SECONDS = 60 * 10;

export type JustificationStatus = 'PENDIENTE' | 'APROBADO' | 'RECHAZADO';

export type PendingJustification = {
  id: string;
  attendanceId: string | null;
  studentId: string;
  studentCode: string;
  studentName: string;
  career: string;
  campusName: string;
  attendanceDate: string;
  checkIn: string | null;
  checkOut: string | null;
  reason: string;
  documentUrl: string | null;
  status: JustificationStatus;
  reviewerNotes: string | null;
  createdAt: string;
  updatedAt: string;
  isAbsence: boolean;
};

export type PendingJustificationsResult = {
  rows: PendingJustification[];
  error: string | null;
};

type JustificationRow = {
  id: string;
  attendance_id: string | null;
  absence_date: string | null;
  student_id: string;
  motivo: string;
  documento_url: string | null;
  status: JustificationStatus;
  notas_revisor: string | null;
  creado_en: string;
  actualizado_en: string;
  student?: {
    student_code: string | null;
    full_name: string | null;
    career: string | null;
  } | null;
  attendance?: {
    date: string | null;
    check_in: string | null;
    check_out: string | null;
    campuses?: { name: string | null } | null;
  } | null;
  absence_campus?: { name: string | null } | null;
};

function getJustificationStoragePath(value: string | null): string | null {
  if (!value) return null;
  if (!/^https?:\/\//i.test(value)) return value;
  const marker = `/storage/v1/object/public/${JUSTIFICATION_BUCKET}/`;
  const markerIndex = value.indexOf(marker);
  if (markerIndex < 0) return null;
  const rawPath = value.slice(markerIndex + marker.length).split('?')[0];
  try {
    return decodeURIComponent(rawPath);
  } catch {
    return rawPath;
  }
}

async function signJustificationDocument(value: string | null): Promise<string | null> {
  const path = getJustificationStoragePath(value);
  if (!path) return null;
  const { data, error } = await supabase.storage
    .from(JUSTIFICATION_BUCKET)
    .createSignedUrl(path, SIGNED_URL_TTL_SECONDS);
  if (error) {
    console.error('Error creating signed justification URL', error);
    return null;
  }
  return data.signedUrl;
}

async function mapPendingJustification(row: JustificationRow): Promise<PendingJustification> {
  return {
    id: row.id,
    attendanceId: row.attendance_id,
    studentId: row.student_id,
    studentCode: row.student?.student_code ?? 'Sin carnet',
    studentName: row.student?.full_name ?? 'Estudiante sin nombre',
    career: row.student?.career ?? 'Sin carrera',
    campusName: row.attendance?.campuses?.name ?? row.absence_campus?.name ?? (row.attendance_id ? 'Sede desconocida' : 'Ausencia sin registro'),
    attendanceDate: row.attendance?.date ?? row.absence_date ?? row.creado_en.slice(0, 10),
    checkIn: row.attendance?.check_in ?? null,
    checkOut: row.attendance?.check_out ?? null,
    reason: row.motivo,
    documentUrl: await signJustificationDocument(row.documento_url),
    status: row.status,
    reviewerNotes: row.notas_revisor,
    createdAt: row.creado_en,
    updatedAt: row.actualizado_en,
    isAbsence: !row.attendance_id,
  };
}

export async function fetchPendingJustificationsResult(): Promise<PendingJustificationsResult> {
  const { data, error } = await supabase
    .from('justifications')
    .select(`
      id,
      attendance_id,
      absence_date,
      student_id,
      motivo,
      documento_url,
      status,
      notas_revisor,
      creado_en,
      actualizado_en,
      student:users!justifications_student_id_fkey(student_code, full_name, career),
      attendance:attendances!justifications_attendance_id_fkey(
        date,
        check_in,
        check_out,
        campuses(name)
      ),
      absence_campus:campuses!justifications_absence_campus_id_fkey(name)
    `)
    .eq('status', 'PENDIENTE')
    .order('creado_en', { ascending: true });

  if (error || !data) {
    if (error) console.error('Error loading pending justifications', error);
    return { rows: [], error: error?.message ?? 'No se pudieron cargar las solicitudes pendientes.' };
  }

  return {
    rows: await Promise.all((data as unknown as JustificationRow[]).map(mapPendingJustification)),
    error: null,
  };
}

export async function fetchPendingJustifications(): Promise<PendingJustification[]> {
  const result = await fetchPendingJustificationsResult();
  return result.rows;
}

export async function reviewJustification(params: {
  id: string;
  status: Exclude<JustificationStatus, 'PENDIENTE'>;
  notes: string;
}): Promise<{ ok: boolean; message?: string }> {
  const { data: authData } = await supabase.auth.getUser();
  const reviewerId = authData.user?.id;

  const { error } = await supabase
    .from('justifications')
    .update({
      status: params.status,
      notas_revisor: params.notes.trim(),
      revisado_por: reviewerId ?? null,
      actualizado_en: new Date().toISOString(),
    })
    .eq('id', params.id);

  if (error) return { ok: false, message: error.message };
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// Funciones del panel del estudiante (T-17.2)
// ─────────────────────────────────────────────────────────────────────────────

export type StudentJustification = {
  id: string;
  attendanceDate: string;
  campusName: string;
  reason: string;
  documentUrl: string | null;
  status: JustificationStatus;
  reviewerNotes: string | null;
  createdAt: string;
  isAbsence: boolean;
};

export type AttendanceOption = {
  id: string;
  date: string;
  campusName: string;
  checkIn: string;
};

export type PresenceConfirmationOption = {
  id: string;
  label: string;
};

export type PresenceConfirmationOptions = {
  students: PresenceConfirmationOption[];
  campuses: PresenceConfirmationOption[];
};

export async function fetchStudentJustifications(): Promise<StudentJustification[]> {
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) return [];

  const { data, error } = await supabase
    .from('justifications')
    .select(`
      id, attendance_id, absence_date, motivo, documento_url, status, notas_revisor, creado_en,
      attendance:attendances!justifications_attendance_id_fkey(
        date, check_in, campuses(name)
      ),
      absence_campus:campuses!justifications_absence_campus_id_fkey(name)
    `)
    .eq('student_id', authData.user.id)
    .order('creado_en', { ascending: false });

  if (error) { reportServiceError('justifications.service.fetchStudentJustifications', error); return []; }
  if (!data) return [];

  return Promise.all((data as any[]).map(async (row) => ({
    id: row.id,
    attendanceDate: row.attendance?.date ?? row.absence_date ?? row.creado_en.slice(0, 10),
    campusName: row.attendance?.campuses?.name ?? row.absence_campus?.name ?? (row.attendance_id ? 'Sede desconocida' : 'Ausencia sin registro'),
    reason: row.motivo,
    documentUrl: await signJustificationDocument(row.documento_url),
    status: row.status as JustificationStatus,
    reviewerNotes: row.notas_revisor,
    createdAt: row.creado_en,
    isAbsence: !row.attendance_id,
  })));
}

export async function fetchStudentAttendances(): Promise<AttendanceOption[]> {
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) return [];

  const { data, error } = await supabase
    .from('attendances')
    .select('id, date, check_in, campuses(name)')
    .eq('student_id', authData.user.id)
    .not('check_out', 'is', null)
    .order('date', { ascending: false })
    .limit(60);

  if (error) { reportServiceError('justifications.service.fetchStudentAttendances', error); return []; }
  if (!data) return [];

  return (data as any[]).map((row) => ({
    id: row.id,
    date: row.date,
    campusName: row.campuses?.name ?? 'Sede desconocida',
    checkIn: row.check_in,
  }));
}

export type CampusOptionLite = { id: string; name: string };

// B3: sedes activas para asociar (opcionalmente) una justificación de ausencia.
export async function fetchActiveCampuses(): Promise<CampusOptionLite[]> {
  const { data } = await supabase.from('campuses').select('id, name').eq('is_active', true).order('name');
  return (data as CampusOptionLite[] | null) ?? [];
}

export async function submitJustification(params: {
  attendanceId?: string;
  absenceDate?: string;       // B3: justificar una ausencia (no se pudo marcar)
  absenceCampusId?: string;   // sede opcional asociada a la ausencia
  reason: string;
  documentFile?: File;
}): Promise<{ ok: boolean; message?: string }> {
  const { data: authData } = await supabase.auth.getUser();
  const userId = authData.user?.id;
  if (!userId) return { ok: false, message: 'Sesión no encontrada.' };

  if (!params.attendanceId && !params.absenceDate) {
    return { ok: false, message: 'Selecciona una asistencia o indica la fecha de la ausencia.' };
  }

  // Verificar que no haya una justificación pendiente para el mismo objetivo.
  let dupQuery = supabase
    .from('justifications')
    .select('id')
    .eq('student_id', userId)
    .eq('status', 'PENDIENTE');
  dupQuery = params.attendanceId
    ? dupQuery.eq('attendance_id', params.attendanceId)
    : dupQuery.eq('absence_date', params.absenceDate as string);
  const { data: existing } = await dupQuery.maybeSingle();

  if (existing) {
    return {
      ok: false,
      message: params.attendanceId
        ? 'Ya tienes una justificación pendiente para esta asistencia.'
        : 'Ya tienes una justificación pendiente para esa fecha.',
    };
  }

  let documentUrl: string | null = null;

  if (params.documentFile) {
    const ext = params.documentFile.name.split('.').pop() ?? 'bin';
    const path = `${userId}/${Date.now()}.${ext}`;
    const { error: uploadError } = await supabase.storage
      .from('justifications')
      .upload(path, params.documentFile, { cacheControl: '3600', upsert: false });

    if (uploadError) return { ok: false, message: 'Error al subir el documento.' };

    documentUrl = path;
  }

  const { error } = await supabase.from('justifications').insert({
    attendance_id: params.attendanceId ?? null,
    absence_date: params.attendanceId ? null : params.absenceDate ?? null,
    absence_campus_id: params.attendanceId ? null : params.absenceCampusId ?? null,
    student_id: userId,
    motivo: params.reason.trim(),
    documento_url: documentUrl,
    status: 'PENDIENTE',
  });

  if (error) return { ok: false, message: error.message };
  return { ok: true };
}

// T-32.1: escalar una justificación rechazada (coordinador la reabre a PENDIENTE).
// La validación de rol y el cambio de estado ocurren en el RPC escalate_justification.
export async function fetchPresenceConfirmationOptions(): Promise<PresenceConfirmationOptions> {
  const [studentsResult, campusesResult] = await Promise.all([
    supabase
      .from('users')
      .select('id, student_code, full_name, career')
      .eq('role', 'STUDENT')
      .order('full_name', { ascending: true }),
    supabase
      .from('campuses')
      .select('id, name, location_label')
      .order('name', { ascending: true }),
  ]);

  return {
    students: (studentsResult.data ?? []).map((student: any) => ({
      id: student.id,
      label: `${student.full_name ?? 'Estudiante sin nombre'} - ${student.student_code ?? 'Sin carnet'}${student.career ? ` (${student.career})` : ''}`,
    })),
    campuses: (campusesResult.data ?? []).map((campus: any) => ({
      id: campus.id,
      label: campus.location_label ?? campus.name ?? 'Sede sin nombre',
    })),
  };
}

export async function confirmHospitalPresenceAfterTechFailure(params: {
  studentId: string;
  campusId: string;
  representativeName: string;
  representativeRole?: string;
  reason?: string;
}): Promise<{ ok: boolean; attendanceId?: string; message?: string }> {
  const { data, error } = await supabase.rpc('confirm_hospital_presence_tech_failure', {
    p_student_id: params.studentId,
    p_campus_id: params.campusId,
    p_representative_name: params.representativeName.trim(),
    p_representative_role: params.representativeRole?.trim() || null,
    p_reason: params.reason?.trim() || null,
  });

  if (error) return { ok: false, message: humanizePresenceConfirmationError(error.message) };
  return { ok: true, attendanceId: data as string };
}

function humanizePresenceConfirmationError(message: string): string {
  if (/asistencia activa/i.test(message)) return 'El estudiante ya tiene una asistencia activa.';
  if (/representante requerido/i.test(message)) return 'Ingresa el nombre del representante.';
  if (/no autorizado/i.test(message)) return 'No tienes permiso para confirmar esta presencia.';
  if (/estudiante no encontrado/i.test(message)) return 'Selecciona un estudiante valido.';
  if (/sede no encontrada/i.test(message)) return 'Selecciona una sede valida.';
  return message;
}

export async function escalateJustification(id: string, nota: string): Promise<{ ok: boolean; message?: string }> {
  const { error } = await supabase.rpc('escalate_justification', { p_id: id, p_nota: nota.trim() || null });
  if (error) return { ok: false, message: error.message };
  return { ok: true };
}

// Justificaciones rechazadas que aún no han sido escaladas (candidatas a segunda revisión).
export async function fetchRejectedJustifications(): Promise<PendingJustification[]> {
  const { data, error } = await supabase
    .from('justifications')
    .select(`
      id, attendance_id, student_id, motivo, documento_url, status, notas_revisor, creado_en, actualizado_en,
      student:users!justifications_student_id_fkey(student_code, full_name, career),
      attendance:attendances!justifications_attendance_id_fkey(date, check_in, check_out, campuses(name))
    `)
    .eq('status', 'RECHAZADO')
    .eq('escalated', false)
    .order('actualizado_en', { ascending: false });

  if (error) { reportServiceError('justifications.service.fetchRejectedJustifications', error); return []; }
  if (!data) return [];

  return Promise.all((data as unknown as JustificationRow[]).map(mapPendingJustification));
}

export type AllJustification = PendingJustification & { reviewerName: string | null };

export async function fetchAllJustifications(): Promise<AllJustification[]> {
  const { data, error } = await supabase
    .from('justifications')
    .select(`
      id, attendance_id, student_id, motivo, documento_url, status, notas_revisor, creado_en, actualizado_en,
      student:users!justifications_student_id_fkey(student_code, full_name, career),
      attendance:attendances!justifications_attendance_id_fkey(date, check_in, check_out, campuses(name)),
      reviewer:users!revisado_por(full_name)
    `)
    .order('creado_en', { ascending: false });

  if (error || !data) {
    if (error) console.error('Error loading all justifications', error);
    return [];
  }

  return Promise.all(
    (data as unknown as (JustificationRow & { reviewer?: { full_name: string | null } | null })[]).map(async (row) => ({
      ...(await mapPendingJustification(row)),
      reviewerName: row.reviewer?.full_name ?? null,
    })),
  );
}

export function subscribeToJustificationChanges(onChange: () => void) {
  const channel = supabase
    .channel('pending-justifications-review')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'justifications' },
      () => onChange(),
    )
    .subscribe();

  return () => {
    void supabase.removeChannel(channel);
  };
}
