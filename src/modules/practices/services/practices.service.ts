import { supabase } from '@/shared/backend/supabaseClient';
import { Practice } from '../types';
import { reportServiceError } from '@/shared/utils/sentry';

export const getPractices = async (): Promise<Practice[]> => {
  const { data, error } = await supabase
    .from('campuses')
    .select('id, name, location_label, supervisor_name, schedule, start_date, end_date, description');

  if (error) { reportServiceError('practices.service.getPractices', error); return []; }
  if (!data) return [];

  return data.map((row) => ({
    id: row.id as string,
    name: (row.name as string) ?? '',
    location: (row.location_label as string) ?? (row.name as string) ?? '',
    supervisor: (row.supervisor_name as string) ?? '',
    schedule: (row.schedule as string) ?? '',
    startDate: (row.start_date as string) ?? '',
    endDate: (row.end_date as string) ?? '',
    description: (row.description as string) ?? '',
  }));
};

export type AssignedStudent = { id: string; name: string; code: string; career: string | null };

// Alumnos asignados a cada sede (vía teacher_groups). Devuelve un mapa
// campus_id -> lista de alumnos, para mostrarlos en la página de prácticas.
export const getStudentsByCampus = async (): Promise<Map<string, AssignedStudent[]>> => {
  const { data } = await supabase
    .from('teacher_groups')
    .select('campus_id, student:users!teacher_groups_student_id_fkey(id, full_name, student_code, career)');

  const map = new Map<string, AssignedStudent[]>();
  (data ?? []).forEach((g: any) => {
    if (!g.campus_id || !g.student) return;
    const student: AssignedStudent = {
      id: g.student.id,
      name: g.student.full_name ?? 'Sin nombre',
      code: g.student.student_code ?? '',
      career: g.student.career ?? null,
    };
    const list = map.get(g.campus_id) ?? [];
    if (!list.some((s) => s.id === student.id)) list.push(student);
    map.set(g.campus_id, list);
  });
  return map;
};
