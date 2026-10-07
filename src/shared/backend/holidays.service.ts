import { supabase } from '@/shared/backend/supabaseClient';
import { reportServiceError } from '@/shared/utils/sentry';

// R-03 — Feriados / días no hábiles. Catálogo compartido: el progreso del alumno
// los excluye de las ausencias y el coordinador/decano los gestiona.
// B15 — un feriado puede marcarse como `recurring` (se repite cada año).

export type Holiday = { date: string; name: string; recurring: boolean };

export async function fetchHolidays(): Promise<Holiday[]> {
  const { data, error } = await supabase
    .from('holidays')
    .select('holiday_date, name, recurring')
    .order('holiday_date');
  if (error) { reportServiceError('holidays.service.fetchHolidays', error); return []; }
  if (!data) return [];
  return (data as any[]).map((h) => ({
    date: h.holiday_date as string,
    name: h.name as string,
    recurring: Boolean(h.recurring),
  }));
}

// Devuelve el conjunto de fechas no hábiles. Los feriados recurrentes se expanden
// al mismo mes-día en una ventana de años alrededor del actual, para que el
// consumidor basado en Set<'YYYY-MM-DD'> funcione sin cambios.
export async function fetchHolidayDates(): Promise<Set<string>> {
  const list = await fetchHolidays();
  const set = new Set<string>();
  const thisYear = new Date().getFullYear();
  for (const h of list) {
    if (!h.recurring) { set.add(h.date); continue; }
    const monthDay = h.date.slice(5); // MM-DD
    for (let y = thisYear - 1; y <= thisYear + 2; y++) set.add(`${y}-${monthDay}`);
  }
  return set;
}

export async function addHoliday(date: string, name: string, recurring = false): Promise<{ ok: boolean; message?: string }> {
  const { error } = await supabase.from('holidays').upsert({ holiday_date: date, name: name.trim(), recurring });
  if (error) return { ok: false, message: error.message };
  return { ok: true };
}

export async function deleteHoliday(date: string): Promise<{ ok: boolean; message?: string }> {
  const { error } = await supabase.from('holidays').delete().eq('holiday_date', date);
  if (error) return { ok: false, message: error.message };
  return { ok: true };
}
