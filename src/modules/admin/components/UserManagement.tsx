import { useState, useEffect, type FormEvent } from 'react';
import { BookOpen, Copy, IdCard, KeyRound, Loader2, Pencil, Puzzle, RefreshCw, Search, ShieldCheck, Trash2, User, UserPlus } from 'lucide-react';
import { Input } from '@/shared/components/ui/input';
import { Label } from '@/shared/components/ui/label';
import { Button } from '@/shared/components/ui/button';
import { Switch } from '@/shared/components/ui/switch';
import { Badge } from '@/shared/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/shared/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/shared/components/ui/alert-dialog';
import { toast } from 'sonner';
import { HelpTooltip } from '@/shared/components/HelpTooltip';
import { PageHeader } from '@/shared/components/PageHeader';
import { supabase } from '@/shared/backend/supabaseClient';
import { toggleUserActive } from '@/modules/dean/services/dean.service';
import { fetchCareers, type Career } from '@/modules/dean/services/catalog.service';
import { fetchPendingAccessRequests, markAccessRequest, type AccessRequest } from '@/modules/auth/access.service';
import { canonicalRole } from '@/shared/utils/roles';

// B-01: las operaciones privilegiadas viven en la Edge Function admin-users.
// El cliente nunca maneja la service_role key.
type AdminAction = 'create' | 'update' | 'delete' | 'reset-password';
async function invokeAdmin<T = Record<string, unknown>>(
  action: AdminAction,
  payload: Record<string, unknown>,
): Promise<{ ok: boolean; message?: string; data?: T }> {
  const { data, error } = await supabase.functions.invoke('admin-users', {
    body: { action, ...payload },
  });
  if (error) {
    // supabase-js marca toda respuesta no-2xx como error y NO parsea el body,
    // así que leemos el JSON del Response para recuperar el mensaje real del servidor.
    let message = error.message ?? 'Error en la operación.';
    const ctx = (error as { context?: Response }).context;
    if (ctx && typeof ctx.json === 'function') {
      try {
        const parsed = await ctx.json();
        if (parsed?.error) message = parsed.error as string;
      } catch { /* el body no era JSON; nos quedamos con el mensaje genérico */ }
    }
    return { ok: false, message };
  }
  if (!data?.ok) {
    return { ok: false, message: data?.error ?? 'Error en la operación.' };
  }
  return { ok: true, data: data as T };
}

const UNIVO_DOMAIN = '@univo.edu.sv';
// Fallback si aún no carga la tabla de carreras (B6). Los ciclos por carrera ahora
// viven en public.careers y el selector de nivel se adapta a ellos.
const CAREERS = ['Enfermería', 'Medicina', 'Fisioterapia', 'Radiología', 'Laboratorio Clínico', 'Nutrición'];
const ROLES = [
  { value: 'STUDENT',        label: 'Estudiante' },
  { value: 'DOCENTE',        label: 'Docente' },
  { value: 'COORDINATOR',    label: 'Coordinador' },
  { value: 'REPRESENTATIVE', label: 'Representante hospitalario' },
  { value: 'ADMIN',          label: 'Administrador / Decano' },
];

// Contraseña temporal fuerte (12 chars, 4 clases) con crypto. Reemplaza el clásico "admin123".
function generateTempPassword(): string {
  const lower = 'abcdefghijkmnpqrstuvwxyz';
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const digits = '23456789';
  const symbols = '!@#$%*?';
  const all = lower + upper + digits + symbols;
  const rand = (n: number) => {
    const a = new Uint32Array(1);
    crypto.getRandomValues(a);
    return a[0] % n;
  };
  const pick = (s: string) => s[rand(s.length)];
  const chars = [pick(lower), pick(upper), pick(digits), pick(symbols)];
  for (let i = 0; i < 8; i++) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = rand(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

interface UserRow {
  id: string;
  student_code: string;
  full_name: string | null;
  email: string;
  role: string;
  career: string | null;
  academic_level: number | null;
  campus_id: string | null;
  is_active: boolean;
}

type CampusOption = { id: string; name: string };

// Muestra email + contraseña tras crear el usuario (o restablecer su contraseña)
type CreatedCredentials = { email: string; password: string; reset?: boolean } | null;

export function UserManagement() {
  const [fullName, setFullName]           = useState('');
  const [studentCode, setStudentCode]     = useState('');
  const [career, setCareer]               = useState(CAREERS[0]);
  const [academicLevel, setAcademicLevel] = useState<number>(1);
  const [campusId, setCampusId]           = useState('');
  const [campuses, setCampuses]           = useState<CampusOption[]>([]);
  const [role, setRole]                   = useState('STUDENT');
  const [requesterRole, setRequesterRole] = useState('');
  const [password, setPassword]           = useState('');
  const [isSubmitting, setIsSubmitting]   = useState(false);
  const [users, setUsers]                 = useState<UserRow[]>([]);
  const [isLoadingUsers, setIsLoadingUsers] = useState(false);
  const [createOpen, setCreateOpen]       = useState(false);
  const [createdCreds, setCreatedCreds]   = useState<CreatedCredentials>(null);

  const [careers, setCareers]             = useState<Career[]>([]);

  const [editingUser, setEditingUser]     = useState<UserRow | null>(null);
  const [editName, setEditName]           = useState('');
  const [editRole, setEditRole]           = useState('STUDENT');
  const [editCareer, setEditCareer]       = useState(CAREERS[0]);
  const [editAcademicLevel, setEditAcademicLevel] = useState<number>(1);
  const [editCampusId, setEditCampusId]   = useState('');
  const [isSavingEdit, setIsSavingEdit]   = useState(false);

  const [deleteTarget, setDeleteTarget]   = useState<UserRow | null>(null);
  const [deletingUserId, setDeletingUserId] = useState<string | null>(null);

  const [togglingId, setTogglingId]       = useState<string | null>(null);
  const [resetingId, setResetingId]       = useState<string | null>(null);

  // #20: búsqueda y filtros de la tabla de usuarios.
  const [search, setSearch]               = useState('');
  const [roleFilter, setRoleFilter]       = useState('all');
  const [careerFilter, setCareerFilter]   = useState('all');

  // #19: solicitudes de acceso pendientes (creadas desde el login).
  const [accessRequests, setAccessRequests] = useState<AccessRequest[]>([]);
  const [processingReqId, setProcessingReqId] = useState<string | null>(null);

  const derivedEmail = studentCode ? `${studentCode.toUpperCase()}${UNIVO_DOMAIN}` : '';

  const resetCreateForm = () => {
    setFullName(''); setStudentCode(''); setCareer(CAREERS[0]);
    setAcademicLevel(1); setCampusId(''); setRole('STUDENT'); setPassword('');
  };

  const openCreate = () => {
    resetCreateForm();
    setPassword(generateTempPassword());
    setCreateOpen(true);
  };

  const loadUsers = async () => {
    setIsLoadingUsers(true);
    const { data, error } = await supabase
      .from('users')
      .select('id, student_code, full_name, email, role, career, academic_level, campus_id, is_active')
      .order('created_at', { ascending: false });
    setIsLoadingUsers(false);
    if (error) { toast.error('Error al cargar usuarios'); return; }
    setUsers((data as UserRow[]) ?? []);
  };

  const loadCampuses = async () => {
    const { data } = await supabase.from('campuses').select('id, name').eq('is_active', true).order('name');
    setCampuses((data as CampusOption[]) ?? []);
  };

  const loadAccessRequests = async () => {
    setAccessRequests(await fetchPendingAccessRequests());
  };

  useEffect(() => { void loadUsers(); void loadCampuses(); void fetchCareers().then(setCareers); void loadAccessRequests(); }, []);

  // #19: aprobar una solicitud crea el usuario (con credenciales temporales que se
  // envían al correo) y marca la solicitud como aprobada. Rechazar solo la cierra.
  const handleApproveRequest = async (req: AccessRequest) => {
    const code = req.studentCode.trim().toUpperCase();
    const email = `${code}${UNIVO_DOMAIN}`;
    const tempPassword = generateTempPassword();
    setProcessingReqId(req.id);
    const result = await invokeAdmin('create', {
      email,
      password: tempPassword,
      student_code: code,
      full_name: req.fullName.trim(),
      role: req.requestedRole,
      career: req.requestedRole === 'STUDENT' ? req.career : null,
      academic_level: req.requestedRole === 'STUDENT' ? 1 : null,
      campus_id: null,
    });
    if (!result.ok) {
      setProcessingReqId(null);
      toast.error(result.message ?? 'No se pudo crear el usuario.');
      return;
    }
    await markAccessRequest(req.id, 'approved');
    setProcessingReqId(null);
    setCreatedCreds({ email, password: tempPassword });
    void supabase.functions
      .invoke('send-credentials', { body: { email, password: tempPassword, full_name: req.fullName.trim() } })
      .then(({ error }) => {
        if (error) toast.error('Usuario creado, pero no se pudieron enviar las credenciales');
        else toast.success('Solicitud aprobada y credenciales enviadas');
      });
    void loadAccessRequests();
    void loadUsers();
  };

  const handleRejectRequest = async (req: AccessRequest) => {
    setProcessingReqId(req.id);
    const result = await markAccessRequest(req.id, 'rejected');
    setProcessingReqId(null);
    if (!result.ok) { toast.error(result.message ?? 'No se pudo rechazar la solicitud.'); return; }
    toast.success('Solicitud rechazada');
    void loadAccessRequests();
  };

  // B6: nombres de carreras y niveles (ciclos) desde la tabla configurable. Las
  // carreras inactivas no se ofrecen en formularios nuevos, pero si un usuario ya
  // tiene una carrera inactiva asignada, se incluye para no perder su valor.
  const activeCareerNames = careers.length ? careers.filter((c) => c.isActive).map((c) => c.name) : CAREERS;
  const careerOptions = (current: string) =>
    (!current || activeCareerNames.includes(current)) ? activeCareerNames : [current, ...activeCareerNames];
  const cyclesFor = (name: string) => careers.find((c) => c.name === name)?.totalCycles ?? 16;
  const levelsFor = (name: string) => Array.from({ length: cyclesFor(name) }, (_, i) => i + 1);

  // Rol del solicitante → define qué roles puede gestionar. El docente solo
  // alumnos y encargados; el ADMIN, cualquiera. Espeja la autorización de admin-users.
  useEffect(() => {
    void supabase.auth.getUser().then(async ({ data }) => {
      if (!data.user?.id) return;
      const { data: row } = await supabase.from('users').select('role').eq('id', data.user.id).single<{ role: string }>();
      setRequesterRole(row?.role ?? '');
    });
  }, []);

  const requesterCanonicalRole = canonicalRole(requesterRole);
  const manageableRoles = requesterCanonicalRole === 'ADMIN'
    ? ['STUDENT', 'TEACHER', 'COORDINATOR', 'ADMIN', 'REPRESENTATIVE']
    : ['STUDENT', 'COORDINATOR'];
  const visibleRoles = ROLES.filter((r) => {
    const canonical = canonicalRole(r.value);
    return Boolean(canonical && manageableRoles.includes(canonical));
  });
  // El docente no ve (ni puede operar) cuentas ADMIN ni de otros docentes.
  const visibleUsers = users.filter((u) => {
    const canonical = canonicalRole(u.role);
    return Boolean(canonical && manageableRoles.includes(canonical));
  });

  // #20: aplica búsqueda (nombre/carné/correo) + filtros de rol y carrera.
  const careerFilterOptions = [...new Set(visibleUsers.map((u) => u.career).filter(Boolean))] as string[];
  const filteredUsers = visibleUsers.filter((u) => {
    const q = search.trim().toLowerCase();
    const matchesSearch = !q
      || (u.full_name ?? '').toLowerCase().includes(q)
      || (u.student_code ?? '').toLowerCase().includes(q)
      || (u.email ?? '').toLowerCase().includes(q);
    const matchesRole = roleFilter === 'all' || (u.role ?? '').toUpperCase() === roleFilter;
    const matchesCareer = careerFilter === 'all' || (u.career ?? '') === careerFilter;
    return matchesSearch && matchesRole && matchesCareer;
  });

  const handleCreate = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const code  = studentCode.trim().toUpperCase();
    const email = `${code}${UNIVO_DOMAIN}`;

    if (role === 'STUDENT') {
      if (!/^U\d{8}$/.test(code)) { toast.error('Carné de estudiante: U + 8 dígitos (ej. U20240001)'); return; }
    } else if (!/^[A-Z0-9]{4,9}$/.test(code)) {
      toast.error('Código: 4 a 9 caracteres alfanuméricos, sin espacios ni símbolos.');
      return;
    }
    if (fullName.trim().length < 3) { toast.error('Ingresa el nombre completo (mínimo 3 caracteres).'); return; }
    if (role === 'REPRESENTATIVE' && !campusId) { toast.error('Selecciona la sede que representa.'); return; }
    if (password.length < 8) { toast.error('La contraseña debe tener al menos 8 caracteres'); return; }

    setIsSubmitting(true);
    const result = await invokeAdmin('create', {
      email,
      password,
      student_code: code,
      full_name: fullName.trim(),
      role,
      career: role === 'STUDENT' ? career : null,
      academic_level: role === 'STUDENT' ? academicLevel : null,
      campus_id: role === 'REPRESENTATIVE' ? campusId : null,
    });
    setIsSubmitting(false);

    if (!result.ok) {
      toast.error(result.message ?? 'Error al crear usuario');
      return;
    }

    setCreatedCreds({ email, password });
    void supabase.functions
      .invoke('send-credentials', { body: { email, password, full_name: fullName.trim() } })
      .then(({ error }) => {
        if (error) toast.error('Usuario creado, pero no se pudieron enviar las credenciales');
        else toast.success('Credenciales enviadas al correo institucional');
      });
    resetCreateForm();
    setCreateOpen(false);
    void loadUsers();
  };

  const openEdit = (user: UserRow) => {
    setEditingUser(user);
    setEditName(user.full_name ?? '');
    setEditRole(user.role);
    setEditCareer(user.career ?? CAREERS[0]);
    setEditAcademicLevel(user.academic_level ?? 1);
    setEditCampusId(user.campus_id ?? '');
  };

  const handleEdit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!editingUser) return;
    if (editRole === 'REPRESENTATIVE' && !editCampusId) { toast.error('Selecciona la sede que representa.'); return; }
    setIsSavingEdit(true);
    const result = await invokeAdmin('update', {
      id: editingUser.id,
      full_name: editName.trim(),
      role: editRole,
      career: editRole === 'STUDENT' ? editCareer : null,
      academic_level: editRole === 'STUDENT' ? editAcademicLevel : null,
      campus_id: editRole === 'REPRESENTATIVE' ? editCampusId : null,
    });
    setIsSavingEdit(false);
    if (!result.ok) { toast.error(result.message ?? 'Error al actualizar'); return; }
    toast.success('Usuario actualizado');
    setEditingUser(null);
    void loadUsers();
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeletingUserId(deleteTarget.id);
    const result = await invokeAdmin<{ deactivated?: boolean }>('delete', { id: deleteTarget.id });
    setDeletingUserId(null);
    if (!result.ok) { toast.error(result.message ?? 'Error al eliminar'); return; }
    // Con historial de asistencias/justificaciones el servidor desactiva en vez de
    // borrar, para no perder las horas certificadas.
    toast.success(result.data?.deactivated
      ? 'El usuario tiene historial de asistencias: se desactivó y se bloqueó su acceso en lugar de eliminarlo.'
      : 'Usuario eliminado');
    setDeleteTarget(null);
    void loadUsers();
  };

  const handleToggleActive = async (user: UserRow) => {
    setTogglingId(user.id);
    const result = await toggleUserActive(user.id, !user.is_active);
    setTogglingId(null);
    if (!result.ok) { toast.error(result.message ?? 'Error al cambiar estado'); return; }
    toast.success(user.is_active ? `${user.full_name ?? user.email} desactivado` : `${user.full_name ?? user.email} activado`);
    void loadUsers();
  };

  const handleResetPassword = async (user: UserRow) => {
    setResetingId(user.id);
    const result = await invokeAdmin<{ password: string; email: string }>('reset-password', { email: user.email });
    setResetingId(null);
    if (!result.ok || !result.data?.password) {
      toast.error(result.message ?? 'No se pudo restablecer la contraseña');
      return;
    }
    // Muestra la nueva contraseña temporal (el usuario la cambia al iniciar sesión).
    setCreatedCreds({ email: user.email, password: result.data.password, reset: true });
    // B7: además, envía la contraseña temporal al correo institucional del usuario.
    void supabase.functions
      .invoke('send-credentials', { body: { email: user.email, password: result.data.password, full_name: user.full_name ?? '', reset: true } })
      .then(async ({ error }) => {
        if (!error) { toast.success('Contraseña restablecida y enviada al correo institucional.'); return; }
        // Muestra el motivo real (p. ej. secretos de Gmail sin configurar o error SMTP),
        // que viene en el cuerpo de la respuesta de la Edge Function.
        let reason = error.message ?? '';
        try {
          const ctx = (error as { context?: { json?: () => Promise<{ error?: string; detail?: string }> } }).context;
          const body = ctx?.json ? await ctx.json() : undefined;
          reason = body?.detail ?? body?.error ?? reason;
        } catch { /* respuesta no-JSON */ }
        toast.error(`Contraseña restablecida, pero no se envió el correo${reason ? `: ${reason}` : '.'}`);
      });
  };

  const roleBadge  = (r: string) => r === 'ADMIN' ? 'bg-purple-100 text-purple-700' : r === 'COORDINATOR' ? 'bg-brand-100 text-brand-700' : 'bg-green-100 text-green-700';
  const roleLabel  = (r: string) => ROLES.find((x) => x.value === r)?.label ?? r;

  return (
    <div className="space-y-8">
      <PageHeader
        title="Gestión de usuarios"
        description="Administra cuentas institucionales, roles y estado de acceso."
        action={(
          <Button className="bg-white/10 border border-white/20 text-white hover:bg-white/20" onClick={openCreate}>
            <UserPlus className="w-4 h-4 mr-2" />Nuevo usuario
          </Button>
        )}
      />

      {/* #19: solicitudes de acceso pendientes (creadas desde el login) */}
      {accessRequests.length > 0 && (
        <div className="bg-amber-50 rounded-xl border border-amber-200 shadow-sm">
          <div className="flex items-center gap-2 px-6 py-4 border-b border-amber-100">
            <UserPlus className="w-4 h-4 text-amber-700" />
            <h2 className="text-base font-semibold text-amber-900">Solicitudes de acceso pendientes</h2>
            <Badge className="bg-amber-200 text-amber-800">{accessRequests.length}</Badge>
          </div>
          <div className="divide-y divide-amber-100">
            {accessRequests.map((r) => {
              // #19: el docente solo puede aprobar los roles que admin-users le deja
              // crear (STUDENT/COORDINATOR). Para los demás, solo el decano aprueba.
              const requestCanonicalRole = canonicalRole(r.requestedRole);
              const canApprove = Boolean(requestCanonicalRole && manageableRoles.includes(requestCanonicalRole));
              return (
              <div key={r.id} className="flex flex-col gap-2 px-6 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="text-sm">
                  <p className="font-medium text-gray-900">{r.fullName} <span className="font-mono text-xs text-gray-500">{r.studentCode}</span></p>
                  <p className="text-xs text-gray-600">{roleLabel(r.requestedRole)}{r.career ? ` · ${r.career}` : ''}{r.reason ? ` — ${r.reason}` : ''}</p>
                  {!canApprove && (
                    <p className="text-xs text-amber-700 mt-0.5">Este rol solo lo puede aprobar el decano.</p>
                  )}
                </div>
                <div className="flex gap-2 shrink-0">
                  <Button size="sm" disabled={processingReqId === r.id || !canApprove} title={!canApprove ? 'Tu rol no puede crear este tipo de usuario.' : undefined} onClick={() => void handleApproveRequest(r)} className="bg-green-700 hover:bg-green-800 text-white">
                    {processingReqId === r.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Aprobar'}
                  </Button>
                  <Button size="sm" variant="outline" disabled={processingReqId === r.id} onClick={() => void handleRejectRequest(r)} className="text-red-700 border-red-200 hover:bg-red-50">
                    Rechazar
                  </Button>
                </div>
              </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="bg-white rounded-xl border border-gray-200 shadow-sm">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <h2 className="text-base font-semibold text-gray-900">Usuarios registrados</h2>
          <Button variant="outline" size="sm" onClick={loadUsers} disabled={isLoadingUsers}>
            <RefreshCw className={`w-4 h-4 mr-1.5 ${isLoadingUsers ? 'animate-spin' : ''}`} />Actualizar
          </Button>
        </div>
        {/* #20: buscador + filtros por rol y carrera */}
        <div className="flex flex-col gap-3 px-6 py-3 border-b border-gray-100 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar por nombre, carné o correo…"
              className="pl-9"
            />
          </div>
          <select
            value={roleFilter}
            onChange={(e) => setRoleFilter(e.target.value)}
            aria-label="Filtrar por rol"
            className="h-10 rounded-md border border-gray-200 bg-white px-3 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-brand-700/25"
          >
            <option value="all">Todos los roles</option>
            {visibleRoles.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
          <select
            value={careerFilter}
            onChange={(e) => setCareerFilter(e.target.value)}
            aria-label="Filtrar por carrera"
            className="h-10 rounded-md border border-gray-200 bg-white px-3 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-brand-700/25"
          >
            <option value="all">Todas las carreras</option>
            {careerFilterOptions.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <span className="text-xs text-gray-400 whitespace-nowrap">{filteredUsers.length} de {visibleUsers.length}</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[600px] text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50">
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Nombre</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Carné</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Correo</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Carrera</th>
                <th className="text-center px-4 py-3 text-xs font-medium text-gray-500 uppercase">Nivel</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Rol</th>
                <th className="text-center px-4 py-3 text-xs font-medium text-gray-500 uppercase">Activo</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {isLoadingUsers ? (
                <tr><td colSpan={8} className="px-6 py-8 text-center text-gray-400"><Loader2 className="w-5 h-5 animate-spin mx-auto" /></td></tr>
              ) : filteredUsers.length === 0 ? (
                <tr><td colSpan={8} className="px-6 py-8 text-center text-gray-400">
                  {visibleUsers.length === 0 ? 'Sin usuarios registrados' : 'Ningún usuario coincide con la búsqueda o los filtros'}
                </td></tr>
              ) : (
                filteredUsers.map((u) => (
                  <tr key={u.id} className={`hover:bg-brand-50 transition-colors ${!u.is_active ? 'opacity-50' : ''}`}>
                    <td className="px-4 py-3 font-medium text-gray-900">{u.full_name ?? '—'}</td>
                    <td className="px-4 py-3 text-gray-600 font-mono text-xs">{u.student_code}</td>
                    <td className="px-4 py-3 text-gray-600 text-xs">{u.email}</td>
                    <td className="px-4 py-3 text-gray-600">{u.career ?? '—'}</td>
                    <td className="px-4 py-3 text-center text-gray-600">{u.academic_level ?? '—'}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${roleBadge(u.role)}`}>
                        {roleLabel(u.role)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-center">
                      {togglingId === u.id ? (
                        <Loader2 className="w-4 h-4 animate-spin mx-auto text-gray-400" />
                      ) : (
                        <Switch
                          checked={u.is_active}
                          onCheckedChange={() => void handleToggleActive(u)}
                          aria-label={u.is_active ? 'Desactivar usuario' : 'Activar usuario'}
                        />
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        <Button size="sm" variant="outline" aria-label={`Editar ${u.full_name ?? u.email}`} onClick={() => openEdit(u)}>
                          <Pencil className="w-3.5 h-3.5" />
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          title="Generar link de restablecimiento de contraseña"
                          aria-label={`Restablecer contraseña de ${u.full_name ?? u.email}`}
                          disabled={resetingId === u.id}
                          onClick={() => void handleResetPassword(u)}
                        >
                          {resetingId === u.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <KeyRound className="w-3.5 h-3.5" />}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="text-red-700 border-red-200 hover:bg-red-50"
                          aria-label={`Eliminar ${u.full_name ?? u.email}`}
                          onClick={() => setDeleteTarget(u)}
                          disabled={deletingUserId === u.id}
                        >
                          {deletingUserId === u.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Modal crear usuario */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader><DialogTitle className="flex items-center gap-2"><UserPlus className="h-5 w-5 text-brand-700" />Nuevo usuario</DialogTitle></DialogHeader>
          <form onSubmit={handleCreate} className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="create-fullName" className="text-xs uppercase tracking-wide text-brand-700"><User className="h-3.5 w-3.5" />Nombre completo</Label>
              <Input id="create-fullName" value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="María Fernanda García" required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="create-studentCode" className="text-xs uppercase tracking-wide text-brand-700 flex items-center gap-1"><IdCard className="h-3.5 w-3.5" />Carné / Código
                <HelpTooltip text="Para estudiantes: U + 8 dígitos (ej. U20240001). Para docentes/coordinadores: 4 a 9 caracteres alfanuméricos. Con este código se arma el correo de acceso institucional." />
              </Label>
              <Input
                id="create-studentCode"
                value={studentCode}
                onChange={(e) => setStudentCode(e.target.value.toUpperCase())}
                placeholder={role === 'STUDENT' ? 'U20240001' : 'Ej. DOC0001'}
                maxLength={9}
                required
              />
              {derivedEmail && (
                <p className="text-xs text-slate-500">
                  Correo de acceso: <span className="text-brand-800 font-medium select-all">{derivedEmail}</span>
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="create-role" className="text-xs uppercase tracking-wide text-brand-700 flex items-center gap-1"><Puzzle className="h-3.5 w-3.5" />Rol
                <HelpTooltip text="Estudiante: marca asistencia y sube justificaciones. Docente: supervisa a su grupo y evalúa. Coordinador: gestiona asignaciones y revisa incidencias. Administrador/Decano: control total, incluido crear usuarios." />
              </Label>
              <select id="create-role" value={role} onChange={(e) => setRole(e.target.value)} className="w-full h-10 rounded-md border border-brand-100 bg-white px-3 text-sm text-brand-900 focus:outline-none focus:ring-2 focus:ring-brand-700/25 focus:border-brand-700">
                {visibleRoles.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
              </select>
            </div>
            {role === 'STUDENT' && (
              <div className="space-y-1.5">
                <Label htmlFor="create-career" className="text-xs uppercase tracking-wide text-brand-700"><BookOpen className="h-3.5 w-3.5" />Carrera</Label>
                <select id="create-career" value={career} onChange={(e) => setCareer(e.target.value)} className="w-full h-10 rounded-md border border-brand-100 bg-white px-3 text-sm text-brand-900 focus:outline-none focus:ring-2 focus:ring-brand-700/25 focus:border-brand-700">
                  {careerOptions(career).map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
            )}
            {role === 'STUDENT' && (
              <div className="space-y-1.5">
                <Label htmlFor="create-level" className="text-xs uppercase tracking-wide text-brand-700 flex items-center gap-1"><BookOpen className="h-3.5 w-3.5" />Ciclo académico
                  <HelpTooltip text={`Ciclo (nivel) que cursa el alumno dentro de su carrera. ${career} tiene ${cyclesFor(career)} ciclos. Las materias con nivel mínimo se bloquean si el alumno no lo alcanza.`} />
                </Label>
                <select id="create-level" value={academicLevel} onChange={(e) => setAcademicLevel(Number(e.target.value))} className="w-full h-10 rounded-md border border-brand-100 bg-white px-3 text-sm text-brand-900 focus:outline-none focus:ring-2 focus:ring-brand-700/25 focus:border-brand-700">
                  {levelsFor(career).map((n) => <option key={n} value={n}>Ciclo {n} de {cyclesFor(career)}</option>)}
                </select>
              </div>
            )}
            {role === 'REPRESENTATIVE' && (
              <div className="space-y-1.5">
                <Label htmlFor="create-campus" className="text-xs uppercase tracking-wide text-brand-700 flex items-center gap-1"><IdCard className="h-3.5 w-3.5" />Sede que representa
                  <HelpTooltip text="El representante hospitalario solo verá y reportará a los estudiantes activos de esta sede." />
                </Label>
                <select id="create-campus" value={campusId} onChange={(e) => setCampusId(e.target.value)} className="w-full h-10 rounded-md border border-brand-100 bg-white px-3 text-sm text-brand-900 focus:outline-none focus:ring-2 focus:ring-brand-700/25 focus:border-brand-700">
                  <option value="">Selecciona una sede…</option>
                  {campuses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="create-password" className="text-xs uppercase tracking-wide text-brand-700 flex items-center gap-1"><ShieldCheck className="h-3.5 w-3.5" />Contraseña temporal
                <HelpTooltip text="Se genera fuerte automáticamente. Cópiala y compártela con el usuario: él la cambia desde su perfil al entrar. El botón ↻ genera otra." />
              </Label>
              <div className="flex items-center gap-2">
                <Input id="create-password" type="text" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Mínimo 8 caracteres" minLength={8} required />
                <Button type="button" variant="outline" size="sm" title="Generar contraseña fuerte" onClick={() => setPassword(generateTempPassword())}>
                  <RefreshCw className="w-3.5 h-3.5" />
                </Button>
              </div>
              <p className="text-xs text-slate-500">Generada automáticamente. Puedes editarla o regenerarla; se mostrará para copiarla.</p>
            </div>
            <div className="sm:col-span-2 flex justify-end pt-2">
              <Button type="submit" disabled={isSubmitting} className="bg-brand-800 hover:bg-brand-900 text-white shadow-sm shadow-brand-900/15">
                {isSubmitting ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Creando...</> : <><UserPlus className="w-4 h-4 mr-2" />Crear usuario</>}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* Modal credenciales creadas */}
      <Dialog open={Boolean(createdCreds)} onOpenChange={() => setCreatedCreds(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle className="flex items-center gap-2"><ShieldCheck className="h-5 w-5 text-brand-700" />{createdCreds?.reset ? 'Contraseña restablecida' : 'Usuario creado exitosamente'}</DialogTitle></DialogHeader>
          {createdCreds && (
            <div className="space-y-4">
              <p className="text-sm text-gray-600">
                {createdCreds.reset
                  ? 'Comparte esta contraseña temporal con el usuario. Deberá cambiarla al iniciar sesión.'
                  : 'Comparte estas credenciales con el usuario. Puede cambiar la contraseña desde su perfil.'}
              </p>
              <div className="space-y-3 rounded-lg bg-brand-50 p-4">
                <div>
                  <p className="text-xs text-gray-500 uppercase tracking-wide mb-1">Correo de acceso</p>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 text-sm font-mono text-gray-900 select-all">{createdCreds.email}</code>
                    <Button size="sm" variant="outline" onClick={() => { void navigator.clipboard.writeText(createdCreds.email); toast.success('Correo copiado'); }}>
                      <Copy className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </div>
                <div>
                  <p className="text-xs text-gray-500 uppercase tracking-wide mb-1">Contraseña temporal</p>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 text-sm font-mono text-gray-900 select-all">{createdCreds.password}</code>
                    <Button size="sm" variant="outline" onClick={() => { void navigator.clipboard.writeText(createdCreds.password); toast.success('Contraseña copiada'); }}>
                      <Copy className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </div>
              </div>
              <p className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  También enviamos estas credenciales al correo del usuario. Pídele que, si no las ve en unos minutos,
                  <strong> revise su carpeta de Spam o Correo no deseado</strong> y marque el mensaje como seguro.
                  Si aun así no llega, compártelas tú con los datos de arriba.
                </span>
              </p>
              <Badge className="bg-amber-100 text-amber-700 text-xs">
                El panel del alumno empieza en /rotations al iniciar sesión
              </Badge>
              <div className="flex justify-end">
                <Button onClick={() => setCreatedCreds(null)} className="bg-brand-700 hover:bg-brand-800 text-white">Entendido</Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Modal editar */}
      <Dialog open={Boolean(editingUser)} onOpenChange={(open) => { if (!open) setEditingUser(null); }}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader><DialogTitle className="flex items-center gap-2"><Pencil className="h-5 w-5 text-brand-700" />Editar usuario</DialogTitle></DialogHeader>
          <form onSubmit={handleEdit} className="grid grid-cols-1 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="edit-name" className="text-xs uppercase tracking-wide text-brand-700"><User className="h-3.5 w-3.5" />Nombre completo</Label>
              <Input id="edit-name" value={editName} onChange={(e) => setEditName(e.target.value)} required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-role" className="text-xs uppercase tracking-wide text-brand-700"><Puzzle className="h-3.5 w-3.5" />Rol</Label>
              <select id="edit-role" value={editRole} onChange={(e) => setEditRole(e.target.value)} className="w-full h-10 rounded-md border border-brand-100 bg-white px-3 text-sm text-brand-900 focus:outline-none focus:ring-2 focus:ring-brand-700/25 focus:border-brand-700">
                {visibleRoles.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
              </select>
            </div>
            {editRole === 'STUDENT' && (
              <div className="space-y-1.5">
                <Label htmlFor="edit-career" className="text-xs uppercase tracking-wide text-brand-700"><BookOpen className="h-3.5 w-3.5" />Carrera</Label>
                <select id="edit-career" value={editCareer} onChange={(e) => setEditCareer(e.target.value)} className="w-full h-10 rounded-md border border-brand-100 bg-white px-3 text-sm text-brand-900 focus:outline-none focus:ring-2 focus:ring-brand-700/25 focus:border-brand-700">
                  {careerOptions(editCareer).map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
            )}
            {editRole === 'STUDENT' && (
              <div className="space-y-1.5">
                <Label htmlFor="edit-level" className="text-xs uppercase tracking-wide text-brand-700 flex items-center gap-1"><BookOpen className="h-3.5 w-3.5" />Ciclo académico
                  <HelpTooltip text={`Ciclo (nivel) que cursa el alumno. ${editCareer} tiene ${cyclesFor(editCareer)} ciclos.`} />
                </Label>
                <select id="edit-level" value={editAcademicLevel} onChange={(e) => setEditAcademicLevel(Number(e.target.value))} className="w-full h-10 rounded-md border border-brand-100 bg-white px-3 text-sm text-brand-900 focus:outline-none focus:ring-2 focus:ring-brand-700/25 focus:border-brand-700">
                  {levelsFor(editCareer).map((n) => <option key={n} value={n}>Ciclo {n} de {cyclesFor(editCareer)}</option>)}
                </select>
              </div>
            )}
            {editRole === 'REPRESENTATIVE' && (
              <div className="space-y-1.5">
                <Label htmlFor="edit-campus" className="text-xs uppercase tracking-wide text-brand-700"><IdCard className="h-3.5 w-3.5" />Sede que representa</Label>
                <select id="edit-campus" value={editCampusId} onChange={(e) => setEditCampusId(e.target.value)} className="w-full h-10 rounded-md border border-brand-100 bg-white px-3 text-sm text-brand-900 focus:outline-none focus:ring-2 focus:ring-brand-700/25 focus:border-brand-700">
                  <option value="">Selecciona una sede…</option>
                  {campuses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
            )}
            <div className="flex justify-end pt-2">
              <Button type="submit" disabled={isSavingEdit} className="bg-brand-800 hover:bg-brand-900 text-white shadow-sm shadow-brand-900/15">
                {isSavingEdit ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Guardando...</> : 'Guardar cambios'}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* Confirmación de eliminación */}
      <AlertDialog open={Boolean(deleteTarget)} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2"><Trash2 className="h-5 w-5 text-red-600" />Eliminar usuario</AlertDialogTitle>
            <AlertDialogDescription>
              ¿Eliminar <strong>{deleteTarget?.email}</strong>? Si el usuario ya tiene asistencias o
              justificaciones, se desactivará y se bloqueará su acceso en lugar de borrarse, para conservar su
              historial. Si no tiene historial, el borrado no se puede deshacer.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={Boolean(deletingUserId)}>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={() => void handleDelete()} disabled={Boolean(deletingUserId)} className="bg-red-600 hover:bg-red-700 text-white">
              {deletingUserId ? 'Eliminando...' : 'Eliminar'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
