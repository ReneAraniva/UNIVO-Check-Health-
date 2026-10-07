// T-23.2: datos del grupo del docente autenticado.
// Provee el roster del grupo y el snapshot de estudiantes activos filtrado por grupo,
// para que el mapa del docente (T-23.1, René) y las evaluaciones (T-26.x) consuman.

import { supabase } from '@/shared/backend/supabaseClient';
import { getActiveStudentsSnapshot } from '@/shared/backend/checkHealthBackend';
import { reportServiceError } from '@/shared/utils/sentry';

export const CURRENT_PERIOD = '2026-1';

export type DaySlot = { weekday: number; from: string; to: string };

export type GoalDecision = 'APROBADO' | 'REPROBADO' | null;

export type TeacherStudent = {
  assignmentId: string; // teacher_groups.id — para decidir la meta del ciclo (#18)
  studentId: string;
  fullName: string;
  studentCode: string;
  career: string;
  campusId: string | null;
  campusName: string;
  subjectId: string | null;
  subjectName: string;
  schedule: DaySlot[]; // #6: horario por día del alumno en esta asignación
  goalDecision: GoalDecision; // #18: decisión del docente sobre la meta
};

// Devuelve los student_id asignados al docente autenticado en el período actual.
async function getGroupStudentIds(period = CURRENT_PERIOD): Promise<string[]> {
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return [];

  const { data, error } = await supabase
    .from('teacher_groups')
    .select('student_id')
    .eq('teacher_id', auth.user.id)
    .eq('period', period);

  if (error) { reportServiceError('teacher.service.getGroupStudentIds', error); return []; }
  if (!data) return [];
  return data.map((r) => r.student_id as string);
}

// Roster del grupo (nombre, carnet, carrera, materia y sede) — para listados,
// evaluaciones y la vista de grupos por materia/sede (S4-04.1).
export async function fetchTeacherRoster(period = CURRENT_PERIOD): Promise<TeacherStudent[]> {
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return [];

  const { data, error } = await supabase
    .from('teacher_groups')
    .select('id, campus_id, subject_id, goal_decision, campus:campuses(name), subject:subjects(name, code), schedules:student_schedules(weekday, check_in_from, check_in_to), student:users!teacher_groups_student_id_fkey(id, full_name, student_code, career)')
    .eq('period', period)
    .eq('teacher_id', auth.user.id);

  if (error) { reportServiceError('teacher.service.fetchTeacherRoster', error); return []; }
  if (!data) return [];

  return (data as any[]).map((row) => ({
    assignmentId: row.id,
    studentId: row.student?.id,
    fullName: row.student?.full_name ?? 'Sin nombre',
    studentCode: row.student?.student_code ?? '',
    career: row.student?.career ?? '—',
    campusId: row.campus_id ?? null,
    campusName: row.campus?.name ?? 'Sin sede',
    subjectId: row.subject_id ?? null,
    subjectName: row.subject ? `${row.subject.code ? `${row.subject.code} · ` : ''}${row.subject.name}` : 'Sin materia',
    schedule: ((row.schedules ?? []) as any[])
      .filter((s) => s.check_in_from && s.check_in_to)
      .map((s) => ({ weekday: s.weekday as number, from: (s.check_in_from as string).slice(0, 5), to: (s.check_in_to as string).slice(0, 5) }))
      .sort((a, b) => a.weekday - b.weekday),
    goalDecision: (row.goal_decision as GoalDecision) ?? null,
  })).filter((s) => s.studentId);
}

// #18: el docente registra si el alumno APROBÓ o REPROBÓ la meta del ciclo.
// La validación de que sea el docente de la asignación vive en el RPC.
export async function decideAssignmentGoal(
  assignmentId: string,
  decision: 'APROBADO' | 'REPROBADO',
  note?: string,
): Promise<{ ok: boolean; message?: string }> {
  const { error } = await supabase.rpc('decide_assignment_goal', {
    p_assignment_id: assignmentId,
    p_decision: decision,
    p_note: note?.trim() || null,
  });
  if (error) return { ok: false, message: error.message };
  return { ok: true };
}

// Snapshot de estudiantes ACTIVOS (con check-in abierto) del grupo del docente.
// Reusa getActiveStudentsSnapshot y filtra por los IDs del grupo (HU-23).
export async function fetchTeacherActiveSnapshot(period = CURRENT_PERIOD) {
  const ids = new Set(await getGroupStudentIds(period));
  if (ids.size === 0) return [];
  const all = await getActiveStudentsSnapshot();
  return all.filter((s) => ids.has(s.studentId));
}
