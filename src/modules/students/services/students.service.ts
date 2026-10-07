import { supabase } from '@/shared/backend/supabaseClient';
import { Student } from '../types';
import { reportServiceError } from '@/shared/utils/sentry';

export const getStudents = async (): Promise<Student[]> => {
  const [{ data, error }, { data: groups }] = await Promise.all([
    supabase
      .from('users')
      .select('id, student_code, full_name, email, career, academic_level, photo_url')
      .eq('role', 'STUDENT'),
    // Sedes asignadas por alumno (para el filtro por sede en la lista).
    supabase
      .from('teacher_groups')
      .select('student_id, campus:campuses(name)'),
  ]);

  if (error) { reportServiceError('students.service.getStudents', error); return []; }
  if (!data) return [];

  // Mapa student_id -> conjunto de nombres de sede.
  const sedesByStudent = new Map<string, Set<string>>();
  (groups ?? []).forEach((g: any) => {
    const name = g.campus?.name as string | undefined;
    if (!g.student_id || !name) return;
    if (!sedesByStudent.has(g.student_id)) sedesByStudent.set(g.student_id, new Set());
    sedesByStudent.get(g.student_id)!.add(name);
  });

  return data.map((row) => ({
    id: row.id as string,
    name: (row.full_name as string) ?? '',
    carnet: (row.student_code as string) ?? '',
    email: (row.email as string) ?? '',
    career: (row.career as string) ?? '',
    academicLevel: (row.academic_level as number) ?? null,
    sedes: Array.from(sedesByStudent.get(row.id as string) ?? []),
    photo: (row.photo_url as string) ?? undefined,
  }));
};
