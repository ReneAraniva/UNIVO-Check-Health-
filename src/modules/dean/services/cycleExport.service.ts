import { supabase } from '@/shared/backend/supabaseClient';
import { csvCell, downloadCsv, toCsv } from '@/shared/utils/csv';
import { reportServiceError } from '@/shared/utils/sentry';

// HU-37 — Exportación de los datos del ciclo (asistencias normalizadas) en
// JSON/CSV para sistemas externos. Cruza asistencias con alumno, materia y sede.

export type CycleRecord = {
  student_code: string;
  student_name: string;
  career: string;
  subject_code: string;
  subject_name: string;
  campus_name: string;
  date: string;
  check_in: string | null;
  check_out: string | null;
  worked_hours: number | null;
  status: string | null;
  review_status: string | null;
};

export async function fetchCycleRecords(period: string): Promise<CycleRecord[]> {
  // Las asignaciones del período acotan los alumnos del ciclo.
  const { data: groups } = await supabase
    .from('teacher_groups')
    .select('student_id')
    .eq('period', period);
  const studentIds = [...new Set((groups ?? []).map((g) => g.student_id as string))];
  if (studentIds.length === 0) return [];

  const { data, error } = await supabase
    .from('attendances')
    .select('date, check_in, check_out, worked_hours, status, review_status, student:users!attendances_student_id_fkey(full_name, student_code, career), subject:subjects(code, name), campus:campuses(name)')
    .in('student_id', studentIds)
    .order('date', { ascending: true });
  if (error) { reportServiceError('cycleExport.service.fetchCycleRecords', error); return []; }
  if (!data) return [];

  return (data as any[]).map((r) => ({
    student_code: r.student?.student_code ?? '',
    student_name: r.student?.full_name ?? '',
    career: r.student?.career ?? '',
    subject_code: r.subject?.code ?? '',
    subject_name: r.subject?.name ?? '',
    campus_name: r.campus?.name ?? '',
    date: r.date ?? '',
    check_in: r.check_in ?? null,
    check_out: r.check_out ?? null,
    worked_hours: r.worked_hours ?? null,
    status: r.status ?? null,
    review_status: r.review_status ?? null,
  }));
}

function download(content: string, mime: string, filename: string) {
  const blob = new Blob([content], { type: `${mime};charset=utf-8;` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// csvCell vive en shared/utils/csv (lo usan los tres exportadores); se reexporta
// por compatibilidad con los imports existentes.
export { csvCell };

export function exportCycleCsv(records: CycleRecord[], period: string) {
  const header = ['Carnet', 'Nombre', 'Carrera', 'Codigo materia', 'Materia', 'Sede', 'Fecha', 'Entrada', 'Salida', 'Horas', 'Estado', 'Revision'];
  const rows = records.map((r) => [
    r.student_code, r.student_name, r.career, r.subject_code, r.subject_name, r.campus_name,
    r.date, r.check_in ?? '', r.check_out ?? '', r.worked_hours ?? '', r.status ?? '', r.review_status ?? '',
  ]);
  downloadCsv(toCsv(header, rows), `ciclo_${period}_${new Date().toISOString().slice(0, 10)}.csv`);
}

export function exportCycleJson(records: CycleRecord[], period: string) {
  const payload = {
    period,
    generated_at: new Date().toISOString(),
    source: 'UNIVO Check-Health',
    record_count: records.length,
    records,
  };
  download(JSON.stringify(payload, null, 2), 'application/json', `ciclo_${period}_${new Date().toISOString().slice(0, 10)}.json`);
}
