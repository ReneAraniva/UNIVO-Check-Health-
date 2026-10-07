import { supabase } from '@/shared/backend/supabaseClient';
import { reportServiceError } from '@/shared/utils/sentry';

// Fase 1 — Servicio de asignaciones. Puebla teacher_groups + student_schedules
// (creadas en la migración 20260530000006). Las escrituras van por RLS:
// solo ADMIN/COORDINATOR pueden gestionar (políticas coordinators_manage_*).

export type PersonOption = { id: string; label: string };
export type CampusOption = { id: string; name: string };
export type SubjectOption = {
  id: string;
  code: string;
  name: string;
  career: string | null;
  required_hours: number;
  min_academic_level: number | null;
};

export type AssignmentOptions = {
  students: PersonOption[];
  teachers: PersonOption[];
  coordinators: PersonOption[];
  campuses: CampusOption[];
  subjects: SubjectOption[];
};

export type ScheduleSlot = {
  weekday: number; // ISO 1=lunes … 7=domingo
  check_in_from: string; // 'HH:MM'
  check_in_to: string;
};

export type Assignment = {
  id: string;
  student_id: string;
  teacher_id: string;
  coordinator_id: string | null;
  campus_id: string | null;
  subject_id: string | null;
  period: string;
  start_date: string | null;
  end_date: string | null;
  required_hours: number | null;
};

export type AssignmentForm = {
  id?: string;
  student_id: string;
  teacher_id: string;
  coordinator_id: string | null;
  campus_id: string | null;
  subject_id: string | null;
  period: string;
  start_date: string | null;
  end_date: string | null;
  required_hours: number | null;
  schedules: ScheduleSlot[];
};

type UserOptionRow = { id: string; full_name: string | null; student_code: string | null; role: string };

export async function fetchAssignmentOptions(): Promise<AssignmentOptions> {
  const [{ data: users }, { data: campuses }, { data: subjects }] = await Promise.all([
    supabase
      .from('users')
      .select('id, full_name, student_code, role')
      .eq('is_active', true)
      .order('full_name'),
    supabase
      .from('campuses')
      .select('id, name')
      .eq('is_active', true)
      .order('name'),
    supabase
      .from('subjects')
      .select('id, code, name, career, required_hours, min_academic_level')
      .eq('is_active', true)
      .order('career')
      .order('name'),
  ]);

  const rows = (users as UserOptionRow[] | null) ?? [];
  const norm = (r: string) => r.toUpperCase();
  const label = (u: UserOptionRow) =>
    u.full_name ? `${u.full_name}${u.student_code ? ` · ${u.student_code}` : ''}` : (u.student_code ?? u.id);

  return {
    students: rows.filter((u) => ['STUDENT', 'ESTUDIANTE', 'ALUMNO'].includes(norm(u.role))).map((u) => ({ id: u.id, label: label(u) })),
    teachers: rows.filter((u) => ['DOCENTE', 'TEACHER'].includes(norm(u.role))).map((u) => ({ id: u.id, label: label(u) })),
    coordinators: rows.filter((u) => ['COORDINATOR', 'COORDINADOR'].includes(norm(u.role))).map((u) => ({ id: u.id, label: label(u) })),
    campuses: ((campuses as CampusOption[] | null) ?? []),
    subjects: ((subjects as SubjectOption[] | null) ?? []),
  };
}

export async function fetchAssignments(): Promise<Assignment[]> {
  const { data, error } = await supabase
    .from('teacher_groups')
    .select('id, student_id, teacher_id, coordinator_id, campus_id, subject_id, period, start_date, end_date, required_hours')
    .order('period', { ascending: false });
  if (error) { reportServiceError('assignments.service.fetchAssignments', error); return []; }
  if (!data) return [];
  return data as Assignment[];
}

// Devuelve un mapa assignment_id → slots de horario (para resumen y edición).
export async function fetchAllSchedules(): Promise<Map<string, ScheduleSlot[]>> {
  const { data, error } = await supabase
    .from('student_schedules')
    .select('assignment_id, weekday, check_in_from, check_in_to')
    .eq('is_active', true)
    .order('weekday');
  const map = new Map<string, ScheduleSlot[]>();
  if (error || !data) return map;
  for (const row of data as (ScheduleSlot & { assignment_id: string })[]) {
    const slots = map.get(row.assignment_id) ?? [];
    slots.push({
      weekday: row.weekday,
      check_in_from: (row.check_in_from ?? '').slice(0, 5),
      check_in_to: (row.check_in_to ?? '').slice(0, 5),
    });
    map.set(row.assignment_id, slots);
  }
  return map;
}

export async function saveAssignment(form: AssignmentForm): Promise<{ ok: boolean; message?: string; gateBlocked?: boolean }> {
  const period = form.period.trim() || '2026-1';

  if (!form.campus_id) {
    return { ok: false, message: 'La sede de practica es obligatoria.' };
  }
  if (!form.subject_id) {
    return { ok: false, message: 'La materia de practica es obligatoria.' };
  }

  const { data: gateData, error: gateError } = await supabase.rpc('validate_assignment_gate', {
    p_student_id: form.student_id,
    p_subject_id: form.subject_id,
  });
  if (gateError) return { ok: false, message: humanizeError(gateError.message) };
  // S4-03.4: el gate bloquea, pero el decano puede forzar con justificación.
  if (gateData?.[0] && !gateData[0].ok) return { ok: false, message: gateData[0].message, gateBlocked: true };

  const payload = {
    student_id: form.student_id,
    teacher_id: form.teacher_id,
    coordinator_id: form.coordinator_id,
    campus_id: form.campus_id,
    subject_id: form.subject_id,
    period,
    start_date: form.start_date || null,
    end_date: form.end_date || null,
    required_hours: form.required_hours ?? null,
  };

  let assignmentId = form.id;
  let conflictQuery = supabase
    .from('teacher_groups')
    .select('id')
    .eq('student_id', form.student_id)
    .eq('campus_id', form.campus_id)
    .eq('subject_id', form.subject_id)
    .eq('period', period)
    .limit(1);

  if (assignmentId) {
    conflictQuery = conflictQuery.neq('id', assignmentId);
  }

  const { data: conflicts, error: conflictError } = await conflictQuery;
  if (conflictError) return { ok: false, message: conflictError.message };
  if ((conflicts ?? []).length > 0) {
    return { ok: false, message: 'Este alumno ya tiene una asignacion para esa materia, sede y periodo.' };
  }

  if (assignmentId) {
    const { error } = await supabase.from('teacher_groups').update(payload).eq('id', assignmentId);
    if (error) return { ok: false, message: humanizeError(error.message) };
  } else {
    const { data, error } = await supabase.from('teacher_groups').insert(payload).select('id').single();
    if (error || !data) return { ok: false, message: humanizeError(error?.message ?? 'No se pudo crear la asignación.') };
    assignmentId = (data as { id: string }).id;
  }

  // Reemplazar el horario completo: borrar e insertar los slots activos.
  const { error: delError } = await supabase.from('student_schedules').delete().eq('assignment_id', assignmentId);
  if (delError) return { ok: false, message: delError.message };

  if (form.schedules.length > 0) {
    const rows = form.schedules.map((s) => ({
      assignment_id: assignmentId,
      weekday: s.weekday,
      check_in_from: s.check_in_from,
      check_in_to: s.check_in_to,
    }));
    const { error: insError } = await supabase.from('student_schedules').insert(rows);
    if (insError) return { ok: false, message: insError.message };
  }

  return { ok: true };
}

// S4-03.4: el decano concede un override del gate para (alumno, materia) con
// justificación obligatoria. Tras esto, saveAssignment vuelve a intentarse.
export async function grantAssignmentOverride(
  studentId: string,
  subjectId: string,
  reason: string,
): Promise<{ ok: boolean; message?: string }> {
  const { error } = await supabase.rpc('grant_assignment_override', {
    p_student_id: studentId,
    p_subject_id: subjectId,
    p_reason: reason,
  });
  if (error) return { ok: false, message: humanizeError(error.message) };
  return { ok: true };
}

// R-04 — Traslado de alumno entre sedes conservando el historial. En vez de
// reescribir la asignación, se cierra la actual (end_date) y se crea una nueva en
// la sede destino, copiando docente/coordinador/materia/horario. La fila vieja y
// sus asistencias quedan como historial.
export async function transferAssignment(
  assignmentId: string,
  newCampusId: string,
  newStartDate: string,
): Promise<{ ok: boolean; message?: string }> {
  if (!newCampusId) return { ok: false, message: 'Selecciona la sede destino.' };
  if (!newStartDate) return { ok: false, message: 'Indica la fecha de inicio en la nueva sede.' };

  const { data: current, error: fetchErr } = await supabase
    .from('teacher_groups')
    .select('student_id, teacher_id, coordinator_id, subject_id, period, required_hours')
    .eq('id', assignmentId)
    .single();
  if (fetchErr || !current) return { ok: false, message: fetchErr?.message ?? 'Asignación no encontrada.' };

  // IMPORTANTE: se crea la nueva asignación PRIMERO. Si los triggers (cupo de sede
  // R-02 o gate de prerrequisitos) la rechazan, la asignación actual queda intacta
  // y el alumno no se queda sin sede. Solo tras el insert exitoso se cierra la vieja.
  const { data: created, error: insErr } = await supabase
    .from('teacher_groups')
    .insert({
      student_id: current.student_id,
      teacher_id: current.teacher_id,
      coordinator_id: current.coordinator_id,
      campus_id: newCampusId,
      subject_id: current.subject_id,
      period: current.period,
      start_date: newStartDate,
      required_hours: current.required_hours,
    })
    .select('id')
    .single();
  if (insErr || !created) return { ok: false, message: humanizeError(insErr?.message ?? 'No se pudo crear la nueva asignación.') };

  // Cierra la asignación actual el día anterior al traslado (ya creada la nueva).
  const prevDay = new Date(`${newStartDate}T00:00:00`);
  prevDay.setDate(prevDay.getDate() - 1);
  const endDate = prevDay.toISOString().slice(0, 10);
  const { error: endErr } = await supabase.from('teacher_groups').update({ end_date: endDate }).eq('id', assignmentId);
  if (endErr) return { ok: false, message: endErr.message };

  // Copia el horario de la asignación anterior a la nueva.
  const { data: slots } = await supabase
    .from('student_schedules')
    .select('weekday, check_in_from, check_in_to')
    .eq('assignment_id', assignmentId)
    .eq('is_active', true);
  if (slots && slots.length > 0) {
    await supabase.from('student_schedules').insert(
      slots.map((s) => ({ assignment_id: (created as { id: string }).id, weekday: s.weekday, check_in_from: s.check_in_from, check_in_to: s.check_in_to })),
    );
  }

  return { ok: true };
}

export async function deleteAssignment(id: string): Promise<{ ok: boolean; message?: string }> {
  // student_schedules se borra en cascada (ON DELETE CASCADE).
  const { error } = await supabase.from('teacher_groups').delete().eq('id', id);
  if (error) return { ok: false, message: error.message };
  return { ok: true };
}

function humanizeError(message: string): string {
  if (message.includes('teacher_groups_unique')) {
    return 'Ese docente ya tiene a ese alumno asignado en el mismo período.';
  }
  return message;
}
