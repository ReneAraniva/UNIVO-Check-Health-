// T-26.2 / T-26.3: evaluación cualitativa semanal del docente.
// Tabla weekly_evaluations (4 dimensiones 1-5) con RLS: el docente solo gestiona
// las suyas (teacher_id = auth.uid()). UNIQUE (teacher_id, student_id, week_start).

import { supabase } from '@/shared/backend/supabaseClient';
import { reportServiceError } from '@/shared/utils/sentry';

export type WeeklyEvaluationInput = {
  studentId: string;
  weekStart: string; // yyyy-mm-dd (lunes de la semana)
  actitud: number;
  puntualidad: number;
  desempenoTecnico: number;
  trabajoEquipo: number;
  comentario?: string;
};

export type WeeklyEvaluation = {
  id: string;
  weekStart: string;
  actitud: number;
  puntualidad: number;
  desempenoTecnico: number;
  trabajoEquipo: number;
  comentario: string | null;
  createdAt: string;
};

// Crea o actualiza la evaluación de la semana (una por estudiante/semana).
export async function upsertWeeklyEvaluation(input: WeeklyEvaluationInput): Promise<{ ok: boolean; message?: string }> {
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return { ok: false, message: 'Sesión no encontrada.' };

  const { error } = await supabase.from('weekly_evaluations').upsert(
    {
      teacher_id: auth.user.id,
      student_id: input.studentId,
      week_start: input.weekStart,
      actitud: input.actitud,
      puntualidad: input.puntualidad,
      desempeno_tecnico: input.desempenoTecnico,
      trabajo_equipo: input.trabajoEquipo,
      comentario: input.comentario?.trim() || null,
    },
    { onConflict: 'teacher_id,student_id,week_start' },
  );

  if (error) return { ok: false, message: error.message };
  return { ok: true };
}

// Historial de evaluaciones de un estudiante (T-26.3), más reciente primero.
export async function fetchStudentEvaluations(studentId: string): Promise<WeeklyEvaluation[]> {
  const { data, error } = await supabase
    .from('weekly_evaluations')
    .select('id, week_start, actitud, puntualidad, desempeno_tecnico, trabajo_equipo, comentario, created_at')
    .eq('student_id', studentId)
    .order('week_start', { ascending: false });

  if (error) { reportServiceError('evaluations.service.fetchStudentEvaluations', error); return []; }
  if (!data) return [];

  return (data as any[]).map((r) => ({
    id: r.id,
    weekStart: r.week_start,
    actitud: r.actitud,
    puntualidad: r.puntualidad,
    desempenoTecnico: r.desempeno_tecnico,
    trabajoEquipo: r.trabajo_equipo,
    comentario: r.comentario,
    createdAt: r.created_at,
  }));
}
