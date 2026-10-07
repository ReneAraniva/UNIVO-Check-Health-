import { supabase } from '@/shared/backend/supabaseClient';
import type { DeanAttendance, DeanGlobalStats, DeanStudent, Location } from '../types';
import { canonicalRole } from '@/shared/utils/roles';
import { reportServiceError } from '@/shared/utils/sentry';

const DEFAULT_GOAL_HOURS = 240;
const SHARED_DEVICE_ALERT_ACTION = 'SHARED_DEVICE_ACTIVE_CONFLICT';
const DEFAULT_RISK_THRESHOLD = 60;

type AttRow = {
  id: string;
  date: string;
  check_in: string;
  check_out: string | null;
  status: string;
  worked_hours: number | null;
  review_status: string;
  campus_id: string;
  campuses: { name: string; supervisor_name: string | null } | null;
};

type UserRow = {
  id: string;
  student_code: string;
  full_name: string | null;
  career: string | null;
  attendances: AttRow[];
};

type CampusRow = {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  radius_meters: number;
  location_label: string | null;
  supervisor_name: string | null;
  supervisor_phone: string | null;
  schedule: string | null;
  start_date: string | null;
  end_date: string | null;
  description: string | null;
  max_students: number | null;
  is_active: boolean;
  check_in_from: string | null;
  check_in_to: string | null;
};

type SharedDeviceAlertRow = {
  id: number;
  actor_user_id: string;
  target_user_id: string | null;
  event_at: string;
  details: {
    attempted_campus_id?: string;
    active_campus_id?: string;
    active_attendance_id?: string;
    device_fingerprint?: string;
  } | null;
};

type CampusScope = {
  role: ReturnType<typeof canonicalRole>;
  userId: string | null;
  campusIds: Set<string> | null;
};

export type SharedDeviceAlert = {
  id: string;
  attemptedStudentId: string;
  activeStudentId: string | null;
  attemptedCampusId: string;
  activeCampusId: string;
  activeAttendanceId: string;
  deviceFingerprint: string;
  createdAt: string;
};

async function fetchRiskThreshold(): Promise<number> {
  const { data } = await supabase
    .from('system_config')
    .select('value')
    .in('key', ['risk_threshold_pct', 'compliance_alert_threshold_pct'])
    .order('key', { ascending: false });

  const rawValue = data?.find((item) => item.value != null)?.value;
  const threshold = Number(rawValue);
  return Number.isFinite(threshold) && threshold > 0 ? threshold : DEFAULT_RISK_THRESHOLD;
}

async function fetchGoalHours(): Promise<number> {
  const { data } = await supabase
    .from('system_config')
    .select('value')
    .eq('key', 'required_practice_hours')
    .single();
  const v = Number(data?.value);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_GOAL_HOURS;
}

async function fetchCampusScope(): Promise<CampusScope> {
  const { data: auth } = await supabase.auth.getUser();
  const userId = auth.user?.id ?? null;
  if (!userId) return { role: null, userId: null, campusIds: null };

  const { data: profile } = await supabase
    .from('users')
    .select('role')
    .eq('id', userId)
    .single<{ role: string }>();
  const role = canonicalRole(profile?.role);

  if (role === 'ADMIN') return { role, userId, campusIds: null };
  if (role !== 'COORDINATOR' && role !== 'TEACHER') return { role, userId, campusIds: new Set() };

  const column = role === 'COORDINATOR' ? 'coordinator_id' : 'teacher_id';
  const { data } = await supabase
    .from('teacher_groups')
    .select('campus_id')
    .eq(column, userId)
    .not('campus_id', 'is', null);

  return {
    role,
    userId,
    campusIds: new Set(((data as { campus_id: string | null }[]) ?? []).map((row) => row.campus_id).filter(Boolean) as string[]),
  };
}

function mapStudentRow(row: UserRow, riskThreshold: number, goalHours = DEFAULT_GOAL_HOURS): DeanStudent {
  const completedHours = row.attendances.reduce((s, a) => s + (a.worked_hours ?? 0), 0);
  const absences = row.attendances.filter((a) => a.status === 'absent').length;
  const pct = Math.min(100, Math.round((completedHours / goalHours) * 100));

  const latest = [...row.attendances].sort((a, b) => b.date.localeCompare(a.date))[0];
  const sedeId = latest?.campus_id ?? '';
  const sedeName = latest?.campuses?.name ?? 'Sin sede';
  const doctorName = latest?.campuses?.supervisor_name ?? '—';

  const attendances: DeanAttendance[] = row.attendances.map((a) => ({
    id: a.id,
    date: a.date,
    checkInTime: a.check_in ? new Date(a.check_in).toLocaleTimeString('es-SV', { hour: '2-digit', minute: '2-digit' }) : '',
    sedeName: a.campuses?.name ?? sedeName,
    status: a.status === 'absent' ? 'absent' : a.review_status === 'OBSERVADO' ? 'review' : 'valid',
  }));

  return {
    id: row.id,
    carnet: row.student_code,
    fullName: row.full_name ?? row.student_code,
    career: row.career ?? '—',
    sedeId,
    sedeName,
    doctorName,
    teacherName: '—',
    coordinatorName: '—',
    completedHours: Math.round(completedHours * 10) / 10,
    goalHours,
    compliancePercentage: pct,
    absences,
    status: pct > 85 ? 'completed' : pct >= riskThreshold ? 'in-progress' : 'at-risk',
    attendances,
  };
}

export async function fetchDeanStudents(): Promise<DeanStudent[]> {
  const [riskThreshold, goalHours, studentsResult] = await Promise.all([
    fetchRiskThreshold(),
    fetchGoalHours(),
    supabase
      .from('users')
      .select(`
        id, student_code, full_name, career,
        attendances(id, date, check_in, check_out, status, worked_hours, review_status, campus_id,
          campuses(name, supervisor_name))
      `)
      .eq('role', 'STUDENT')
      .order('date', { foreignTable: 'attendances', ascending: false })
      .limit(50, { foreignTable: 'attendances' }),
  ]);

  if (studentsResult.error || !studentsResult.data) return [];
  return (studentsResult.data as unknown as UserRow[]).map((row) => mapStudentRow(row, riskThreshold, goalHours));
}

export async function fetchDeanLocations(scope?: CampusScope): Promise<Location[]> {
  const { data, error } = await supabase
    .from('campuses')
    .select('id, name, latitude, longitude, radius_meters, location_label, supervisor_name, supervisor_phone, schedule, start_date, end_date, description, is_active, max_students, check_in_from, check_in_to')
    .order('name');

  if (error) { reportServiceError('dean.service.fetchDeanLocations', error); return []; }
  if (!data) return [];

  const rows = scope?.campusIds
    ? (data as CampusRow[]).filter((c) => scope.campusIds!.has(c.id))
    : (data as CampusRow[]);

  return rows.map((c) => ({
    id: c.id,
    name: c.name,
    address: c.location_label ?? c.name,
    coordinates: { lat: Number(c.latitude), lng: Number(c.longitude) },
    allowedRadiusMeters: c.radius_meters,
    doctorName: c.supervisor_name ?? '—',
    doctorPhone: c.supervisor_phone ?? '',
    schedule: c.schedule ?? '',
    startDate: c.start_date ?? '',
    endDate: c.end_date ?? '',
    description: c.description ?? '',
    doctorStatus: 'active' as const,
    totalStudents: 0,
    averageCompliance: 0,
    status: (c.is_active ? 'active' : 'inactive') as 'active' | 'inactive',
    students: [],
    maxStudents: c.max_students ?? null,
    checkInFrom: c.check_in_from ? (c.check_in_from as string).slice(0, 5) : '',
    checkInTo: c.check_in_to ? (c.check_in_to as string).slice(0, 5) : '',
  }));
}

export async function toggleCampusActive(id: string, isActive: boolean): Promise<{ ok: boolean; message?: string }> {
  const { error } = await supabase
    .from('campuses')
    .update({ is_active: isActive })
    .eq('id', id);
  if (error) return { ok: false, message: error.message };
  return { ok: true };
}

// is_active es columna del sistema (fn_protect_users_columns rechaza el UPDATE
// directo desde el navegador), así que el cambio pasa por la Edge Function
// admin-users, que además bloquea/desbloquea el inicio de sesión en Auth.
export async function toggleUserActive(id: string, isActive: boolean): Promise<{ ok: boolean; message?: string }> {
  const { data, error } = await supabase.functions.invoke('admin-users', {
    body: { action: 'set-active', id, is_active: isActive },
  });
  if (error) {
    let message = error.message ?? 'Error al cambiar estado';
    const ctx = (error as { context?: Response }).context;
    if (ctx && typeof ctx.json === 'function') {
      try {
        const parsed = await ctx.json();
        if (parsed?.error) message = parsed.error as string;
      } catch { /* body no JSON */ }
    }
    return { ok: false, message };
  }
  if (!data?.ok) return { ok: false, message: data?.error ?? 'Error al cambiar estado' };
  return { ok: true };
}

type AssignmentInfo = {
  studentId: string;
  campusId: string;
  campusName: string;
  supervisorName: string;
  teacherName: string;
  coordinatorName: string;
};

// #4/#10/#17: asignación oficial del alumno (teacher_groups) — fuente de verdad de
// su sede, docente y coordinador, independiente de si ya marcó asistencia. Se filtran
// las vigentes por fecha; un alumno puede tener varias (multi-sede).
async function fetchActiveAssignments(scope?: CampusScope): Promise<AssignmentInfo[]> {
  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from('teacher_groups')
    .select(`
      student_id, campus_id, start_date, end_date,
      campus:campuses(name, supervisor_name),
      teacher:users!teacher_groups_teacher_id_fkey(full_name),
      coordinator:users!teacher_groups_coordinator_id_fkey(full_name)
    `);
  if (error) { reportServiceError('dean.service.fetchActiveAssignments', error); return []; }
  if (!data) return [];
  return (data as any[])
    .filter((r) => (!r.start_date || r.start_date <= today) && (!r.end_date || r.end_date >= today))
    .filter((r) => !scope?.campusIds || scope.campusIds.has(r.campus_id))
    .map((r) => ({
      studentId: r.student_id,
      campusId: r.campus_id,
      campusName: r.campus?.name ?? 'Sin sede',
      supervisorName: r.campus?.supervisor_name ?? '—',
      teacherName: r.teacher?.full_name ?? '—',
      coordinatorName: r.coordinator?.full_name ?? '—',
    }));
}

export async function fetchDeanData(): Promise<{
  students: DeanStudent[];
  locations: Location[];
  globalStats: DeanGlobalStats;
}> {
  const scope = await fetchCampusScope();
  const [students, locations, assignments, riskThreshold] = await Promise.all([
    fetchDeanStudents(),
    fetchDeanLocations(scope),
    fetchActiveAssignments(scope),
    fetchRiskThreshold(),
  ]);

  const studentMap = new Map(students.map((s) => [s.id, s]));
  const locMap = new Map(locations.map((l) => [l.id, l]));

  // #4/#17: sobreponer la asignación oficial (sede/docente/coordinador) al alumno.
  // La primera vigente se usa como sede "principal" para la tabla/detalle.
  const primaryByStudent = new Map<string, AssignmentInfo>();
  assignments.forEach((a) => { if (!primaryByStudent.has(a.studentId)) primaryByStudent.set(a.studentId, a); });
  primaryByStudent.forEach((a, studentId) => {
    const s = studentMap.get(studentId);
    if (!s) return;
    s.sedeId = a.campusId;
    s.sedeName = a.campusName;
    s.doctorName = a.supervisorName;
    s.teacherName = a.teacherName;
    s.coordinatorName = a.coordinatorName;
  });

  // #10: poblar los alumnos asignados por sede (un alumno puede figurar en varias).
  const seen = new Set<string>();
  assignments.forEach((a) => {
    const loc = locMap.get(a.campusId);
    const s = studentMap.get(a.studentId);
    if (!loc || !s) return;
    const key = `${a.campusId}:${a.studentId}`;
    if (seen.has(key)) return;
    seen.add(key);
    loc.students.push(s);
  });
  locMap.forEach((loc) => {
    loc.totalStudents = loc.students.length;
    loc.averageCompliance = loc.students.length
      ? Math.round(loc.students.reduce((sum, st) => sum + st.compliancePercentage, 0) / loc.students.length)
      : 0;
  });

  const globalStats: DeanGlobalStats = {
    totalStudents: students.length,
    globalComplianceRate:
      students.length > 0
        ? Math.round(students.reduce((s, st) => s + st.compliancePercentage, 0) / students.length)
        : 0,
    atRiskCount: students.filter((s) => s.status === 'at-risk').length,
    activeLocations: locations.filter((l) => l.status === 'active').length,
    riskThreshold,
  };

  return { students, locations, globalStats };
}

export async function fetchSharedDeviceAlerts(): Promise<SharedDeviceAlert[]> {
  const { data, error } = await supabase
    .from('audit_log')
    .select('id, actor_user_id, target_user_id, event_at, details')
    .eq('action', SHARED_DEVICE_ALERT_ACTION)
    .order('event_at', { ascending: false })
    .limit(20);

  if (error) { reportServiceError('dean.service.fetchSharedDeviceAlerts', error); return []; }
  if (!data) return [];

  return (data as SharedDeviceAlertRow[]).map((row) => ({
    id: String(row.id),
    attemptedStudentId: row.actor_user_id,
    activeStudentId: row.target_user_id,
    attemptedCampusId: row.details?.attempted_campus_id ?? '',
    activeCampusId: row.details?.active_campus_id ?? '',
    activeAttendanceId: row.details?.active_attendance_id ?? '',
    deviceFingerprint: row.details?.device_fingerprint ?? '',
    createdAt: row.event_at,
  }));
}

export type CampusFormData = {
  name: string;
  latitude: string;
  longitude: string;
  radius_meters: string;
  location_label: string;
  supervisor_name: string;
  supervisor_phone: string;
  schedule: string;
  start_date: string;
  end_date: string;
  description: string;
  check_in_from: string;
  check_in_to: string;
  max_students: string; // R-02: cupo máximo (vacío = sin límite)
};

export async function createCampus(form: CampusFormData): Promise<{ ok: boolean; message?: string }> {
  const radius = Math.max(50, Number(form.radius_meters) || 100);
  const { error } = await supabase.from('campuses').insert({
    name: form.name.trim(),
    latitude: Number(form.latitude),
    longitude: Number(form.longitude),
    radius_meters: radius,
    location_label: form.location_label.trim() || null,
    supervisor_name: form.supervisor_name.trim() || null,
    supervisor_phone: form.supervisor_phone.trim() || null,
    schedule: form.schedule.trim() || null,
    start_date: form.start_date || null,
    end_date: form.end_date || null,
    description: form.description.trim() || null,
    check_in_from: form.check_in_from || null,
    check_in_to: form.check_in_to || null,
    max_students: form.max_students.trim() ? Number(form.max_students) : null,
  });
  if (error) return { ok: false, message: error.message };
  return { ok: true };
}

export async function updateCampus(id: string, form: CampusFormData): Promise<{ ok: boolean; message?: string }> {
  const radius = Math.max(50, Number(form.radius_meters) || 100);
  const { error } = await supabase
    .from('campuses')
    .update({
      name: form.name.trim(),
      latitude: Number(form.latitude),
      longitude: Number(form.longitude),
      radius_meters: radius,
      location_label: form.location_label.trim() || null,
      supervisor_name: form.supervisor_name.trim() || null,
      supervisor_phone: form.supervisor_phone.trim() || null,
      schedule: form.schedule.trim() || null,
      start_date: form.start_date || null,
      end_date: form.end_date || null,
      description: form.description.trim() || null,
      check_in_from: form.check_in_from || null,
      check_in_to: form.check_in_to || null,
      max_students: form.max_students.trim() ? Number(form.max_students) : null,
    })
    .eq('id', id);
  if (error) return { ok: false, message: error.message };
  return { ok: true };
}

export async function deleteCampus(id: string): Promise<{ ok: boolean; message?: string; blocked?: boolean }> {
  const { error } = await supabase.from('campuses').delete().eq('id', id);
  if (error) {
    // 23503 = foreign_key_violation: la sede tiene asistencias/asignaciones que la
    // referencian. El historial es inmutable, así que no se borra: se desactiva.
    if (error.code === '23503') {
      return {
        ok: false,
        blocked: true,
        message: 'Esta sede tiene asistencias o asignaciones registradas, por lo que no puede eliminarse (el historial es inmutable). Desactívala para ocultarla sin perder los registros.',
      };
    }
    return { ok: false, message: error.message };
  }
  return { ok: true };
}
