// B-01: Operaciones administrativas de usuarios, server-side.
// Reemplaza el uso de service_role en el frontend (que se empaquetaba en el bundle).
// La service key vive aquí, nunca en el cliente.
//
// S4-04.2 (delegación): el ADMIN gestiona cualquier rol; el DOCENTE gestiona SOLO
// alumnos (STUDENT) y encargados (COORDINATOR), nunca ADMIN ni otro DOCENTE. La
// autorización se valida server-side por rol del solicitante y rol del objetivo.
// Supabase inyecta SUPABASE_URL, SUPABASE_ANON_KEY y SUPABASE_SERVICE_ROLE_KEY automáticamente.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { getCorsHeaders } from '../_shared/cors.ts';
import { withSentry } from '../_shared/sentry.ts';

type Action = 'create' | 'update' | 'delete' | 'reset-password';

type Body = {
  action?: Action;
  // create
  email?: string;
  password?: string;
  student_code?: string;
  full_name?: string;
  role?: string;
  career?: string | null;
  academic_level?: number | null;
  campus_id?: string | null;
  // update / delete / reset
  id?: string;
};

// Nivel académico (escala híbrida año/ciclo): smallint 1..10 o null. Solo aplica a STUDENT.
function normalizeAcademicLevel(value: unknown, role: string): number | null {
  if (role !== 'STUDENT') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 10) return null;
  return n;
}

// Contraseña temporal fuerte (sin caracteres ambiguos). Se usa al restablecer.
function generateTempPassword(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const specials = '!@#$%&*';
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let out = '';
  for (let i = 0; i < 10; i++) out += chars[bytes[i] % chars.length];
  out += specials[bytes[10] % specials.length];
  out += String(bytes[11] % 10);
  return out;
}

async function logDelegatedUserAction(
  admin: ReturnType<typeof createClient>,
  params: {
    action: string;
    actorUserId: string;
    actorRole: string;
    targetUserId?: string | null;
    details: Record<string, unknown>;
  },
): Promise<void> {
  const { error } = await admin.from('audit_log').insert({
    action: params.action,
    actor_user_id: params.actorUserId,
    target_user_id: params.targetUserId ?? null,
    details: {
      actor_role: params.actorRole,
      source: 'admin-users',
      ...params.details,
    },
  });
  if (error) throw new Error(`No se pudo registrar auditoria: ${error.message}`);
}

Deno.serve(withSentry('admin-users', async (req: Request) => {
  const cors = getCorsHeaders(req);
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ error: 'No autorizado' }, 401);

  // Cliente con el JWT del solicitante: identifica al usuario y respeta RLS
  const userClient = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } },
  );

  const { data: { user }, error: authError } = await userClient.auth.getUser();
  if (authError || !user) return json({ error: 'Sesión inválida' }, 401);

  // Rol del solicitante (lee su propia fila vía RLS)
  const { data: profile } = await userClient.from('users').select('role').eq('id', user.id).single();
  const rawRequesterRole = (profile?.role ?? '').toUpperCase();
  // Normaliza sinónimos: un decano puede tener rol 'ADMINISTRADOR'/'DECANO'.
  const requesterRole = (rawRequesterRole === 'ADMINISTRADOR' || rawRequesterRole === 'DECANO') ? 'ADMIN' : rawRequesterRole;
  const isAdmin = requesterRole === 'ADMIN';
  const isTeacher = requesterRole === 'DOCENTE' || requesterRole === 'TEACHER';
  if (!isAdmin && !isTeacher) {
    return json({ error: 'No tienes permisos para gestionar usuarios.' }, 403);
  }

  // Roles que el solicitante puede gestionar. El docente solo alumnos y encargados;
  // nunca ADMIN ni otro DOCENTE (ni para crear, editar, borrar o resetear).
  const manageableRoles = isAdmin
    ? ['STUDENT', 'DOCENTE', 'COORDINATOR', 'ADMIN', 'REPRESENTATIVE']
    : ['STUDENT', 'COORDINATOR'];
  const canManageRole = (r: string | null | undefined): boolean =>
    manageableRoles.includes((r ?? '').toUpperCase());

  // Cliente con service_role para las operaciones privilegiadas (server-side)
  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const body = await req.json().catch(() => ({})) as Body;

  switch (body.action) {
    case 'create': {
      if (!body.email || !body.password || !body.student_code) {
        return json({ error: 'Faltan datos requeridos.' }, 400);
      }

      const code = body.student_code.trim().toUpperCase();
      const email = body.email.trim().toLowerCase();
      const role = (body.role ?? 'STUDENT').toUpperCase();

      // Validaciones server-side (defensa en profundidad; el front también valida).
      const ALLOWED_ROLES = ['STUDENT', 'DOCENTE', 'COORDINATOR', 'ADMIN', 'REPRESENTATIVE'];
      if (!ALLOWED_ROLES.includes(role)) {
        return json({ error: 'Rol no válido.' }, 400);
      }
      if (!canManageRole(role)) {
        return json({ error: 'No tienes permiso para crear usuarios con ese rol.' }, 403);
      }
      // student_code es varchar(9): un código más largo reventaría en BD.
      if (role === 'STUDENT' ? !/^U\d{8}$/.test(code) : !/^[A-Z0-9]{4,9}$/.test(code)) {
        return json({ error: role === 'STUDENT'
          ? 'Carné de estudiante inválido (debe ser U + 8 dígitos).'
          : 'Código inválido: 4 a 9 caracteres alfanuméricos.' }, 400);
      }
      if ((body.password ?? '').length < 8) {
        return json({ error: 'La contraseña debe tener al menos 8 caracteres.' }, 400);
      }

      // Pre-chequeo de duplicados → mensaje claro y sin dejar usuario huérfano en Auth.
      const { data: dupes } = await admin
        .from('users')
        .select('student_code, email')
        .or(`student_code.eq.${code},email.eq.${email}`);
      if (dupes && dupes.length > 0) {
        const byCode = dupes.some((d) => (d.student_code ?? '').toUpperCase() === code);
        return json({ error: byCode
          ? `Ya existe un usuario con el carné/código ${code}.`
          : `Ya existe un usuario con el correo ${email}.` }, 409);
      }

      const { data: created, error: createErr } = await admin.auth.admin.createUser({
        email,
        password: body.password,
        email_confirm: true,
      });
      if (createErr || !created.user) {
        const msg = (createErr?.message ?? '').toLowerCase().includes('already')
          ? `Ya existe un usuario con el correo ${email}.`
          : `Error al crear usuario: ${createErr?.message ?? 'desconocido'}`;
        return json({ error: msg }, createErr?.message?.toLowerCase().includes('already') ? 409 : 400);
      }

      const { error: profileErr } = await admin.from('users').insert({
        id:           created.user.id,
        student_code: code,
        full_name:    (body.full_name ?? '').trim(),
        email,
        role,
        career:       role === 'STUDENT' ? (body.career ?? null) : null,
        academic_level: normalizeAcademicLevel(body.academic_level, role),
        campus_id:    role === 'REPRESENTATIVE' ? (body.campus_id ?? null) : null,
        // La contraseña generada es de un solo uso: se obliga a cambiarla al
        // primer ingreso (gate en MainLayout vía complete_password_change).
        must_change_password: true,
      });
      if (profileErr) {
        // Rollback del usuario Auth para no dejar huérfanos
        await admin.auth.admin.deleteUser(created.user.id);
        return json({ error: `Error al crear perfil: ${profileErr.message}` }, 400);
      }
      await logDelegatedUserAction(admin, {
        action: 'DELEGATED_USER_CREATED',
        actorUserId: user.id,
        actorRole: requesterRole,
        targetUserId: created.user.id,
        details: {
          target_email: email,
          target_code: code,
          target_role: role,
        },
      });
      return json({ ok: true, id: created.user.id });
    }

    case 'update': {
      if (!body.id) return json({ error: 'id requerido' }, 400);

      // El solicitante debe poder gestionar TANTO el rol actual del objetivo
      // (no editar a un ADMIN/DOCENTE siendo docente) COMO el rol nuevo (no promover).
      const { data: target } = await admin
        .from('users')
        .select('role, email, student_code, full_name')
        .eq('id', body.id)
        .single();
      if (!target) return json({ error: 'Usuario no encontrado.' }, 404);
      if (!canManageRole(target.role)) {
        return json({ error: 'No tienes permiso para editar a este usuario.' }, 403);
      }
      const newRole = (body.role ?? 'STUDENT').toUpperCase();
      if (!canManageRole(newRole)) {
        return json({ error: 'No tienes permiso para asignar ese rol.' }, 403);
      }

      const { error } = await admin.from('users').update({
        full_name: body.full_name ?? '',
        role:      newRole,
        career:    newRole === 'STUDENT' ? (body.career ?? null) : null,
        academic_level: normalizeAcademicLevel(body.academic_level, newRole),
        campus_id: newRole === 'REPRESENTATIVE' ? (body.campus_id ?? null) : null,
      }).eq('id', body.id);
      if (error) return json({ error: error.message }, 400);
      await logDelegatedUserAction(admin, {
        action: 'DELEGATED_USER_UPDATED',
        actorUserId: user.id,
        actorRole: requesterRole,
        targetUserId: body.id,
        details: {
          previous_role: target.role,
          new_role: newRole,
          full_name: body.full_name ?? '',
          career: newRole === 'STUDENT' ? (body.career ?? null) : null,
        },
      });
      return json({ ok: true });
    }

    case 'delete': {
      if (!body.id) return json({ error: 'id requerido' }, 400);

      const { data: target } = await admin
        .from('users')
        .select('role, email, student_code, full_name')
        .eq('id', body.id)
        .single();
      if (!target) return json({ error: 'Usuario no encontrado.' }, 404);
      if (!canManageRole(target.role)) {
        return json({ error: 'No tienes permiso para eliminar a este usuario.' }, 403);
      }

      // attendances.student_id NO tiene ON DELETE CASCADE → bloquea el borrado del
      // perfil. Las borramos antes (y las justificaciones, por su FK a attendances).
      // El resto (teacher_groups, push_tokens, weekly_evaluations…) cae por CASCADE.
      await admin.from('justifications').delete().eq('student_id', body.id);
      const { error: attErr } = await admin.from('attendances').delete().eq('student_id', body.id);
      if (attErr) {
        return json({ error: `No se pudieron eliminar las asistencias del usuario: ${attErr.message}` }, 400);
      }

      const { error: profErr } = await admin.from('users').delete().eq('id', body.id);
      if (profErr) {
        return json({ error: `No se pudo eliminar el perfil: ${profErr.message}` }, 400);
      }

      // Si la cuenta de Auth ya no existe (p. ej. un perfil huérfano de un borrado
      // previo a medias), no es un error: el objetivo ya se cumplió.
      const { error: authErr } = await admin.auth.admin.deleteUser(body.id);
      if (authErr && !/not[ _-]?found|user.*not|no.*user/i.test(authErr.message ?? '')) {
        return json({ error: `Perfil eliminado, pero falló al borrar en Auth: ${authErr.message}` }, 400);
      }
      await logDelegatedUserAction(admin, {
        action: 'DELEGATED_USER_DELETED',
        actorUserId: user.id,
        actorRole: requesterRole,
        targetUserId: body.id,
        details: {
          target_email: target.email,
          target_code: target.student_code,
          target_name: target.full_name,
          target_role: target.role,
        },
      });
      return json({ ok: true });
    }

    case 'reset-password': {
      if (!body.email) return json({ error: 'email requerido' }, 400);
      const email = body.email.trim().toLowerCase();

      const { data: target } = await admin.from('users').select('id, role').eq('email', email).single();
      if (!target) return json({ error: 'Usuario no encontrado.' }, 404);
      if (!canManageRole(target.role)) {
        return json({ error: 'No tienes permiso para restablecer la contraseña de este usuario.' }, 403);
      }

      // En vez de un link de recuperación (que dependía del Site URL de Supabase y
      // apuntaba a localhost), se asigna una contraseña temporal de un solo uso y se
      // exige cambiarla al primer ingreso — el mismo flujo robusto de la creación.
      const tempPassword = generateTempPassword();
      const { error: pwErr } = await admin.auth.admin.updateUserById(target.id, { password: tempPassword });
      if (pwErr) return json({ error: `No se pudo restablecer la contraseña: ${pwErr.message}` }, 400);
      await admin.from('users').update({ must_change_password: true }).eq('id', target.id);

      await logDelegatedUserAction(admin, {
        action: 'DELEGATED_USER_PASSWORD_RESET',
        actorUserId: user.id,
        actorRole: requesterRole,
        targetUserId: target.id,
        details: {
          target_email: email,
          target_role: target.role,
        },
      });
      return json({ ok: true, password: tempPassword, email });
    }

    default:
      return json({ error: 'Acción no soportada.' }, 400);
  }
}));
