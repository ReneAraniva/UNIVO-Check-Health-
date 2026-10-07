import { supabase } from '@/shared/backend/supabaseClient';
import type { LiveMapStudent } from '@/shared/components/StudentLiveMap';
import { reportServiceError } from '@/shared/utils/sentry';

// HU-38 / HU-40 — Portal del Representante Hospitalario. Todo va por RPCs
// SECURITY DEFINER (server-side) que restringen al representante a su propia sede.

export type CampusActiveStudent = {
  attendanceId: string;
  studentId: string;
  studentName: string;
  studentCode: string;
  career: string;
  siteName: string;
  checkIn: string;
  hoursToday: number;
  lastLocation: { latitude: number; longitude: number } | null;
};

export async function fetchCampusActiveStudents(): Promise<CampusActiveStudent[]> {
  const { data, error } = await supabase.rpc('get_campus_active_students');
  if (error) { reportServiceError('hospital.service.fetchCampusActiveStudents', error); return []; }
  if (!data) return [];
  return (data as any[]).map((r) => ({
    attendanceId: r.attendance_id,
    studentId: r.student_id,
    studentName: r.student_name ?? 'Desconocido',
    studentCode: r.student_code ?? '',
    career: r.career ?? 'Sin carrera',
    siteName: r.site_name ?? 'Sede no registrada',
    checkIn: r.check_in,
    hoursToday: Number(r.hours_today ?? 0),
    lastLocation: r.last_location ?? null,
  }));
}

// Adaptador para reutilizar el mismo StudentLiveMap del decano/docente.
export async function fetchCampusLiveSnapshot(): Promise<LiveMapStudent[]> {
  const rows = await fetchCampusActiveStudents();
  return rows.map((r) => ({
    studentName: r.studentName,
    carnet: r.studentCode,
    siteName: r.siteName,
    hoursToday: r.hoursToday,
    lastLocation: r.lastLocation,
  }));
}

export async function reportStudentConduct(
  attendanceId: string,
  motivo: string,
): Promise<{ ok: boolean; message?: string }> {
  const { error } = await supabase.rpc('report_student_conduct', {
    p_attendance_id: attendanceId,
    p_motivo: motivo,
  });
  if (error) return { ok: false, message: error.message };
  return { ok: true };
}

// #7 — Materias / prácticas programadas en la sede del representante.
export type CampusSubject = {
  subjectId: string | null;
  subjectCode: string;
  subjectName: string;
  career: string | null;
  teacherName: string;
  studentCount: number;
  scheduleDays: string | null;
};

export async function fetchCampusSubjects(): Promise<CampusSubject[]> {
  const { data, error } = await supabase.rpc('get_campus_subjects');
  if (error) { reportServiceError('hospital.service.fetchCampusSubjects', error); return []; }
  if (!data) return [];
  return (data as any[]).map((r) => ({
    subjectId: r.subject_id ?? null,
    subjectCode: r.subject_code ?? '',
    subjectName: r.subject_name ?? 'Práctica general',
    career: r.career ?? null,
    teacherName: r.teacher_name ?? 'Sin docente asignado',
    studentCount: Number(r.student_count ?? 0),
    scheduleDays: r.schedule_days ?? null,
  }));
}

export type ConductReport = {
  id: string;
  studentName: string;
  motivo: string;
  campusName: string;
  createdAt: string;
};

export async function fetchMyConductReports(): Promise<ConductReport[]> {
  const { data, error } = await supabase.rpc('get_my_conduct_reports');
  if (error) { reportServiceError('hospital.service.fetchMyConductReports', error); return []; }
  if (!data) return [];
  return (data as any[]).map((r) => ({
    id: r.id,
    studentName: r.student_name ?? 'Estudiante',
    motivo: r.motivo ?? '',
    campusName: r.campus_name ?? 'Sede',
    createdAt: r.created_at,
  }));
}
