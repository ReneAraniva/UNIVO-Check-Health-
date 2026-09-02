// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import WebSocket from 'ws';

// El CI fija Node 20, que no trae WebSocket nativo (llegó recién en Node 22) — sin
// esto, createClient() explota al armar su cliente de Realtime aunque este test
// nunca lo use (falla en el constructor, no al usarlo). Local con Node 24 no hacía
// falta, por eso no se detectó hasta que el CI lo corrió por primera vez.
const supabaseOptions = { realtime: { transport: WebSocket as unknown as typeof globalThis.WebSocket } };

// Test de integración en vivo (no mockeado): confirma contra un Supabase real que
// un alumno autenticado NO puede escalar privilegios ni leer/escribir lo que no le
// corresponde — arnés de RLS de HU-Q01, arrancó cubriendo HU-S01/S02
// (20260831004457_fix_column_level_protection_users_attendances.sql) y se
// generalizó (C1-03) al encontrar la exposición de system_config
// (20260831012401_fix_system_config_secret_exposure.sql) y otros casos.
//
// Requiere el stack local de Supabase corriendo (`supabase start`) y
// CI_RLS_INTEGRATION=true. Sin esa variable el suite se salta (no falla), para no
// romper `pnpm test` en una máquina sin el backend local levantado. El job
// "migrations" del CI la activa después de aplicar las migraciones en limpio.

// El proyecto no trae @types/node en el tsconfig (es una app de navegador); esto
// evita necesitarlo solo para leer las 4 variables de entorno de este test.
declare const process: { env: Record<string, string | undefined> };

const RUN = process.env.CI_RLS_INTEGRATION === 'true';
const SUPABASE_URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321';
const ANON_KEY = process.env.SUPABASE_ANON_KEY ?? '';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

describe.skipIf(!RUN)('Arnés de RLS de seguridad (HU-Q01 / HU-S01 / HU-S02)', () => {
  let admin: SupabaseClient;
  let asStudent: SupabaseClient;
  let asOtherStudent: SupabaseClient;
  let studentId: string;
  let otherStudentId: string;
  let campusId: string;
  let legitAttendanceId: string;
  const email = `rls-test-${Date.now()}@univo.edu.sv`;
  const otherEmail = `rls-test-other-${Date.now()}@univo.edu.sv`;
  const password = 'RlsTest123!';

  async function createTestStudent(studentEmail: string, code: string) {
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email: studentEmail,
      password,
      email_confirm: true,
    });
    if (createErr || !created.user) {
      throw new Error(`No se pudo crear el usuario de prueba: ${createErr?.message}`);
    }
    const { error: profileErr } = await admin.from('users').insert({
      id: created.user.id,
      student_code: code,
      full_name: `RLS Test ${code}`,
      email: studentEmail,
      role: 'STUDENT',
    });
    if (profileErr) {
      throw new Error(`No se pudo crear el perfil de prueba: ${profileErr.message}`);
    }
    const client = createClient(SUPABASE_URL, ANON_KEY, supabaseOptions);
    const { error: signInErr } = await client.auth.signInWithPassword({ email: studentEmail, password });
    if (signInErr) {
      throw new Error(`No se pudo iniciar sesión como ${studentEmail}: ${signInErr.message}`);
    }
    return { id: created.user.id, client };
  }

  beforeAll(async () => {
    admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, supabaseOptions);

    const { data: campuses } = await admin.from('campuses').select('id').limit(1);
    campusId = campuses?.[0]?.id ?? '00000000-0000-4000-a000-000000000099';

    const main = await createTestStudent(email, 'RLSTEST01');
    studentId = main.id;
    asStudent = main.client;

    const other = await createTestStudent(otherEmail, 'RLSTEST02');
    otherStudentId = other.id;
    asOtherStudent = other.client;

    // Asistencia "legítima" simulando lo que dejaría validate-qr-checkin (via
    // service_role), para probar que el alumno no puede editarla después.
    const { data: attendance, error: attErr } = await admin
      .from('attendances')
      .insert({
        student_id: studentId,
        campus_id: campusId,
        check_in: new Date(Date.now() - 8 * 3600 * 1000).toISOString(),
        check_out: new Date().toISOString(),
        worked_hours: 8,
        review_status: 'PENDIENTE',
      })
      .select('id')
      .single();
    if (attErr) throw new Error(`No se pudo sembrar la asistencia legítima: ${attErr.message}`);
    legitAttendanceId = attendance.id;
  });

  afterAll(async () => {
    if (studentId) {
      await admin.from('attendances').delete().eq('student_id', studentId);
      await admin.from('users').delete().eq('id', studentId);
      await admin.auth.admin.deleteUser(studentId);
    }
    if (otherStudentId) {
      await admin.from('users').delete().eq('id', otherStudentId);
      await admin.auth.admin.deleteUser(otherStudentId);
    }
  });

  it('HU-S01: un alumno no puede escalar su propio rol a ADMIN', async () => {
    await asStudent.from('users').update({ role: 'ADMIN' }).eq('id', studentId).select();

    const { data: after } = await admin.from('users').select('role').eq('id', studentId).single();
    expect(after?.role).toBe('STUDENT');
  });

  it('HU-S01: un alumno no puede desactivarse ni saltarse must_change_password', async () => {
    await asStudent.from('users').update({ is_active: false, must_change_password: true }).eq('id', studentId);

    const { data: after } = await admin
      .from('users')
      .select('is_active, must_change_password')
      .eq('id', studentId)
      .single();
    expect(after?.is_active).not.toBe(false);
  });

  it('HU-S02: un alumno no puede forjar una fila de asistencia por insert directo', async () => {
    const { data, error } = await asStudent
      .from('attendances')
      .insert({
        student_id: studentId,
        campus_id: campusId,
        check_in: new Date(Date.now() - 8 * 3600 * 1000).toISOString(),
        check_out: new Date().toISOString(),
        worked_hours: 8,
        review_status: 'APROBADO',
      })
      .select();

    expect(error).toBeTruthy();
    expect(data ?? []).toHaveLength(0);
  });

  it('el alumno SÍ puede seguir editando las columnas de auto-edición de su perfil', async () => {
    const { error } = await asStudent.from('users').update({ phone: '70000000' }).eq('id', studentId);
    expect(error).toBeNull();

    const { data: after } = await admin.from('users').select('phone').eq('id', studentId).single();
    expect(after?.phone).toBe('70000000');
  });

  it('un alumno no puede leer system_config completo (solo la allowlist operativa)', async () => {
    const { data } = await asStudent.from('system_config').select('key');
    const keys = (data ?? []).map((r) => r.key);

    expect(keys).not.toContain('dispatch_webhook_secret');
    expect(keys).not.toContain('supabase_anon_key');
    expect(keys).not.toContain('supabase_project_url');
  });

  it('el alumno SÍ puede leer las claves operativas que usa el panel del decano', async () => {
    const { data, error } = await asStudent
      .from('system_config')
      .select('value')
      .eq('key', 'required_practice_hours')
      .single();
    expect(error).toBeNull();
    expect(data?.value).toBeTruthy();
  });

  it('un alumno no puede modificar system_config (defensa en profundidad)', async () => {
    const { error, data } = await asStudent
      .from('system_config')
      .update({ value: 'hackeado' })
      .eq('key', 'required_practice_hours')
      .select();
    expect(data ?? []).toHaveLength(0);
    void error;
  });

  it('un alumno no puede editar una asistencia ya registrada (worked_hours/review_status)', async () => {
    await asStudent
      .from('attendances')
      .update({ worked_hours: 999, review_status: 'APROBADO' })
      .eq('id', legitAttendanceId);

    const { data: after } = await admin
      .from('attendances')
      .select('worked_hours, review_status')
      .eq('id', legitAttendanceId)
      .single();
    expect(after?.worked_hours).toBe(8);
    expect(after?.review_status).toBe('PENDIENTE');
  });

  it('un alumno no puede leer el perfil completo de otro alumno', async () => {
    const { data } = await asStudent.from('users').select('id').eq('id', otherStudentId);
    expect(data ?? []).toHaveLength(0);
  });
});
