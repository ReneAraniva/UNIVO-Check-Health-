import { supabase } from '@/shared/backend/supabaseClient';
import { reportServiceError } from '@/shared/utils/sentry';

// B5 + B6: catálogo académico (carreras y materias) gestionado por ADMIN/COORDINATOR.

export type Career = {
  id: string;
  name: string;
  totalCycles: number;
  isActive: boolean;
};

export type Subject = {
  id: string;
  code: string;
  name: string;
  career: string | null;
  requiredHours: number;
  minAcademicLevel: number | null;
  isActive: boolean;
};

type Result = { ok: boolean; message?: string };

// ── Carreras ──────────────────────────────────────────────────────────────────
export async function fetchCareers(): Promise<Career[]> {
  const { data, error } = await supabase
    .from('careers')
    .select('id, name, total_cycles, is_active')
    .order('name');
  if (error) { reportServiceError('catalog.service.fetchCareers', error); return []; }
  if (!data) return [];
  return data.map((c: any) => ({
    id: c.id, name: c.name, totalCycles: c.total_cycles, isActive: c.is_active,
  }));
}

export async function upsertCareer(form: { id?: string; name: string; totalCycles: number; isActive: boolean }): Promise<Result> {
  const payload = { name: form.name.trim(), total_cycles: form.totalCycles, is_active: form.isActive };
  const { error } = form.id
    ? await supabase.from('careers').update(payload).eq('id', form.id)
    : await supabase.from('careers').insert(payload);
  if (error) return { ok: false, message: error.message };
  return { ok: true };
}

export async function deleteCareer(id: string): Promise<Result> {
  const { error } = await supabase.from('careers').delete().eq('id', id);
  if (error) {
    if ((error as { code?: string }).code === '23503') {
      return { ok: false, message: 'No se puede eliminar: hay alumnos o materias asociados a esta carrera. Edítala y desactívala ("activa" en off) para ocultarla sin perder los datos.' };
    }
    return { ok: false, message: error.message };
  }
  return { ok: true };
}

// ── Materias ──────────────────────────────────────────────────────────────────
export async function fetchSubjects(): Promise<Subject[]> {
  const { data, error } = await supabase
    .from('subjects')
    .select('id, code, name, career, required_hours, min_academic_level, is_active')
    .order('code');
  if (error) { reportServiceError('catalog.service.fetchSubjects', error); return []; }
  if (!data) return [];
  return data.map((s: any) => ({
    id: s.id, code: s.code, name: s.name, career: s.career,
    requiredHours: s.required_hours, minAcademicLevel: s.min_academic_level, isActive: s.is_active,
  }));
}

export async function upsertSubject(form: {
  id?: string;
  code: string;
  name: string;
  career: string | null;
  requiredHours: number;
  minAcademicLevel: number | null;
  isActive: boolean;
}): Promise<Result> {
  const payload = {
    code: form.code.trim().toUpperCase(),
    name: form.name.trim(),
    career: form.career || null,
    required_hours: form.requiredHours,
    min_academic_level: form.minAcademicLevel,
    is_active: form.isActive,
  };
  const { error } = form.id
    ? await supabase.from('subjects').update(payload).eq('id', form.id)
    : await supabase.from('subjects').insert(payload);
  if (error) return { ok: false, message: error.message };
  return { ok: true };
}

export async function deleteSubject(id: string): Promise<Result> {
  const { error } = await supabase.from('subjects').delete().eq('id', id);
  if (error) {
    if ((error as { code?: string }).code === '23503') {
      return { ok: false, message: 'No se puede eliminar: hay asignaciones o asistencias que usan esta materia. Edítala y desactívala ("activa" en off) para ocultarla sin perder los datos.' };
    }
    return { ok: false, message: error.message };
  }
  return { ok: true };
}
