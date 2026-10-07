// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import WebSocket from 'ws';

// Regresiones de la auditoría del 2026-10-06 (migraciones 20261006000001…05).
// Igual que rlsSecurity.test.ts: corre contra el stack local recién migrado y solo
// con CI_RLS_INTEGRATION=true (el job "migrations" del CI lo activa).

declare const process: { env: Record<string, string | undefined> };

const RUN = process.env.CI_RLS_INTEGRATION === 'true';
const SUPABASE_URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321';
const ANON_KEY = process.env.SUPABASE_ANON_KEY ?? '';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const options = { realtime: { transport: WebSocket as unknown as typeof globalThis.WebSocket } };

const CAMPUS = { latitude: 13.4833, longitude: -88.1833 };

describe.skipIf(!RUN)('Auditoría 2026-10-06 — regresiones de seguridad y asistencias', () => {
  const stamp = Date.now();
  const password = 'RlsTest123!';
  let admin: SupabaseClient;
  let anon: SupabaseClient;
  let asStudent: SupabaseClient;
  let asOther: SupabaseClient;
  let asCoordinator: SupabaseClient;
  const ids: Record<'student' | 'other' | 'coordinator' | 'dean', string> = {
    student: '', other: '', coordinator: '', dean: '',
  };
  let campusId = '';
  let assignmentId = '';

  async function createUser(key: keyof typeof ids, role: string, code: string) {
    const email = `rls-aud-${key}-${stamp}@univo.edu.sv`;
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (error || !data.user) throw new Error(`createUser ${key}: ${error?.message}`);
    const { error: profileErr } = await admin.from('users').insert({
      id: data.user.id, student_code: code, full_name: `Auditoria ${key}`, email, role,
    });
    if (profileErr) throw new Error(`perfil ${key}: ${profileErr.message}`);
    ids[key] = data.user.id;
    const client = createClient(SUPABASE_URL, ANON_KEY, options);
    const { error: signInErr } = await client.auth.signInWithPassword({ email, password });
    if (signInErr) throw new Error(`login ${key}: ${signInErr.message}`);
    return client;
  }

  const openAttendance = async (studentId: string, fingerprint = 'fp-test') => {
    const { data, error } = await admin.from('attendances').insert({
      student_id: studentId,
      campus_id: campusId,
      assignment_id: studentId === ids.student ? assignmentId : null,
      check_in: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
      check_in_location: CAMPUS,
      device_fingerprint: fingerprint,
    }).select('id').single();
    if (error) throw new Error(`asistencia: ${error.message}`);
    return data.id as string;
  };

  beforeAll(async () => {
    admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, options);
    anon = createClient(SUPABASE_URL, ANON_KEY, options);

    const { data: campus, error: campusErr } = await admin.from('campuses').insert({
      name: `Sede auditoría ${stamp}`, ...CAMPUS, radius_meters: 200,
    }).select('id').single();
    if (campusErr) throw new Error(`sede: ${campusErr.message}`);
    campusId = campus.id;

    asStudent = await createUser('student', 'STUDENT', 'RLSAUD01');
    asOther = await createUser('other', 'STUDENT', 'RLSAUD02');
    asCoordinator = await createUser('coordinator', 'COORDINATOR', 'RLSAUD03');
    await createUser('dean', 'ADMIN', 'RLSAUD04');

    const { data: group, error: groupErr } = await admin.from('teacher_groups').insert({
      teacher_id: ids.coordinator, coordinator_id: ids.coordinator, student_id: ids.student, campus_id: campusId,
    }).select('id').single();
    if (groupErr) throw new Error(`asignación: ${groupErr.message}`);
    assignmentId = group.id;

    // Horario de todo el día para hoy (hora de El Salvador), así la prueba no
    // depende de la hora a la que corra el CI.
    const sv = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/El_Salvador' }));
    const weekday = ((sv.getDay() + 6) % 7) + 1;
    const { error: slotErr } = await admin.from('student_schedules').insert({
      assignment_id: assignmentId, weekday, check_in_from: '00:00', check_in_to: '23:59:59',
    });
    if (slotErr) throw new Error(`horario: ${slotErr.message}`);
  });

  afterAll(async () => {
    const userIds = Object.values(ids).filter(Boolean);
    if (userIds.length) {
      await admin.from('attendances').delete().in('student_id', userIds);
      await admin.from('teacher_groups').delete().in('student_id', userIds);
      await admin.from('users').delete().in('id', userIds);
      for (const id of userIds) await admin.auth.admin.deleteUser(id);
    }
    if (campusId) await admin.from('campuses').delete().eq('id', campusId);
  });

  // ── C-1 ──────────────────────────────────────────────────────────────────────
  it('C-1: un coordinador no puede cambiar el correo de respaldo ni la respuesta de seguridad del decano', async () => {
    await asCoordinator.from('users')
      .update({ backup_email: 'atacante@example.com' })
      .eq('id', ids.dean);

    const { data } = await admin.from('users').select('backup_email').eq('id', ids.dean).single();
    expect(data?.backup_email).not.toBe('atacante@example.com');
  });

  it('C-1: un coordinador no puede fijar el hash de respuesta de seguridad de un alumno', async () => {
    const { error } = await asCoordinator.from('users')
      .update({ security_answer_hash: '$2a$06$abcdefghijklmnopqrstuuJqzK4c3l4o7Y6rRnH7h2yQh2kz0Qz6' })
      .eq('id', ids.student);
    expect(error).toBeTruthy();
  });

  it('C-1: nadie lee security_answer_hash por la Data API', async () => {
    const { error } = await asCoordinator.from('users').select('security_answer_hash').limit(1);
    expect(error).toBeTruthy();
  });

  it('el alumno sigue pudiendo editar su propio correo de respaldo', async () => {
    const { error } = await asStudent.from('users')
      .update({ backup_email: 'respaldo-alumno@example.com' })
      .eq('id', ids.student);
    expect(error).toBeNull();
  });

  it('regresión: complete_password_change funciona (estaba bloqueado por el trigger)', async () => {
    await admin.from('users').update({ must_change_password: true }).eq('id', ids.other);
    const { error } = await asOther.rpc('complete_password_change');
    expect(error).toBeNull();
    const { data } = await admin.from('users').select('must_change_password').eq('id', ids.other).single();
    expect(data?.must_change_password).toBe(false);
  });

  // ── A-1 ──────────────────────────────────────────────────────────────────────
  it.each([
    ['rate_limit_hit', { p_bucket: 'checkin', p_key: 'x', p_max: 0, p_window_seconds: 60 }],
    ['verify_security_answer', { p_email: 'x@univo.edu.sv', p_answer: 'x' }],
    ['fn_retry_pending_outbox', {}],
    ['close_due_cycles', {}],
    ['fn_enqueue_checkout_reminders', {}],
  ])('A-1: anon no puede ejecutar %s', async (fn, args) => {
    const { error } = await anon.rpc(fn, args);
    expect(error).toBeTruthy();
  });

  it('A-1: un alumno autenticado tampoco puede bloquear el check-in de otro con rate_limit_hit', async () => {
    const { error } = await asStudent.rpc('rate_limit_hit', {
      p_bucket: 'checkin', p_key: ids.other, p_max: 0, p_window_seconds: 60,
    });
    expect(error).toBeTruthy();
  });

  it('anon sigue pudiendo usar las RPC previas al login', async () => {
    const { error } = await anon.rpc('email_for_login', { p_identifier: 'RLSAUD01' });
    expect(error).toBeNull();
  });

  // ── M-2 ──────────────────────────────────────────────────────────────────────
  it('M-2: un alumno no puede falsificar eventos de auditoría', async () => {
    const { error } = await asStudent.from('audit_log').insert({
      action: 'CYCLE_CLOSED', actor_user_id: ids.student, details: { forged: true },
    });
    expect(error).toBeTruthy();
  });

  it('M-2: el cliente sí registra sus eventos de UI', async () => {
    const { error } = await asStudent.from('audit_log').insert({
      action: 'UI_ERROR', actor_user_id: ids.student, details: { test: true },
    });
    expect(error).toBeNull();
  });

  // ── C-2 / A-4 ────────────────────────────────────────────────────────────────
  it('C-2: el alumno registra su salida con hora y horas del servidor', async () => {
    const attendanceId = await openAttendance(ids.student);
    const { data, error } = await asStudent.rpc('register_check_out', {
      p_attendance_id: attendanceId,
      p_lat: CAMPUS.latitude,
      p_lng: CAMPUS.longitude,
      p_accuracy: 10,
      p_device_fingerprint: 'fp-test',
    });
    expect(error).toBeNull();
    expect(data?.ok).toBe(true);

    const { data: row } = await admin.from('attendances')
      .select('check_out, worked_hours').eq('id', attendanceId).single();
    expect(row?.check_out).toBeTruthy();
    expect(Number(row?.worked_hours)).toBeGreaterThanOrEqual(1.9);
    expect(Number(row?.worked_hours)).toBeLessThanOrEqual(2.1);
  });

  it('C-2: la salida se rechaza fuera de la geocerca', async () => {
    const attendanceId = await openAttendance(ids.student);
    const { data } = await asStudent.rpc('register_check_out', {
      p_attendance_id: attendanceId, p_lat: 13.7, p_lng: -89.2, p_accuracy: 10, p_device_fingerprint: 'fp-test',
    });
    expect(data?.ok).toBe(false);
    await admin.from('attendances').delete().eq('id', attendanceId);
  });

  it('C-2: un alumno no puede cerrar la jornada de otro', async () => {
    const attendanceId = await openAttendance(ids.other, 'fp-other');
    const { data } = await asStudent.rpc('register_check_out', {
      p_attendance_id: attendanceId, p_lat: CAMPUS.latitude, p_lng: CAMPUS.longitude, p_accuracy: 10,
    });
    expect(data?.ok).toBe(false);
    const { data: row } = await admin.from('attendances').select('check_out').eq('id', attendanceId).single();
    expect(row?.check_out).toBeNull();
  });

  it('A-4: no puede haber dos entradas abiertas del mismo alumno', async () => {
    // ids.other ya tiene una abierta (test anterior).
    const { error } = await admin.from('attendances').insert({
      student_id: ids.other, campus_id: campusId, check_in_location: CAMPUS,
    });
    expect(error?.code).toBe('23505');
  });

  it('el coordinador no puede reescribir horas trabajadas por la Data API', async () => {
    const { data: rows } = await admin.from('attendances')
      .select('id, worked_hours').eq('student_id', ids.student).not('check_out', 'is', null).limit(1);
    const row = rows?.[0];
    expect(row).toBeTruthy();
    const { error } = await asCoordinator.from('attendances').update({ worked_hours: 99 }).eq('id', row!.id);
    expect(error).toBeTruthy();
  });

  it('M-4: el coordinador registra la entrada de un alumno de su asignación', async () => {
    await admin.from('attendances').delete().eq('student_id', ids.student).is('check_out', null);
    const { data, error } = await asCoordinator.rpc('staff_register_check_in', {
      p_student_id: ids.student,
      p_campus_id: campusId,
      p_lat: CAMPUS.latitude,
      p_lng: CAMPUS.longitude,
    });
    expect(error).toBeNull();
    expect(data?.ok).toBe(true);
  });

  it('M-4: un alumno no puede usar el registro manual del encargado', async () => {
    const { data } = await asOther.rpc('staff_register_check_in', {
      p_student_id: ids.other, p_campus_id: campusId, p_lat: CAMPUS.latitude, p_lng: CAMPUS.longitude,
    });
    expect(data?.ok).toBe(false);
  });
});
