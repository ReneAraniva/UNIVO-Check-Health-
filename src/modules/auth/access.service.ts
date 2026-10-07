import { supabase } from '@/shared/backend/supabaseClient';
import { reportServiceError } from '@/shared/utils/sentry';

// #19 — Solicitudes de credenciales desde el login.
export type AccessRequest = {
  id: string;
  fullName: string;
  studentCode: string;
  email: string | null;
  career: string | null;
  requestedRole: string;
  reason: string | null;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: string;
};

export async function submitAccessRequest(input: {
  fullName: string;
  studentCode: string;
  email?: string;
  career?: string;
  requestedRole: string;
  reason?: string;
}): Promise<{ ok: boolean; message?: string }> {
  const { error } = await supabase.from('access_requests').insert({
    full_name: input.fullName.trim(),
    student_code: input.studentCode.trim().toUpperCase(),
    email: input.email?.trim() || null,
    career: input.career?.trim() || null,
    requested_role: input.requestedRole,
    reason: input.reason?.trim() || null,
    status: 'pending',
  });
  if (error) return { ok: false, message: error.message };
  return { ok: true };
}

export async function fetchPendingAccessRequests(): Promise<AccessRequest[]> {
  const { data, error } = await supabase
    .from('access_requests')
    .select('id, full_name, student_code, email, career, requested_role, reason, status, created_at')
    .eq('status', 'pending')
    .order('created_at', { ascending: true });
  if (error) { reportServiceError('access.service.fetchPendingAccessRequests', error); return []; }
  if (!data) return [];
  return (data as Record<string, any>[]).map((r) => ({
    id: r.id,
    fullName: r.full_name,
    studentCode: r.student_code,
    email: r.email,
    career: r.career,
    requestedRole: r.requested_role,
    reason: r.reason,
    status: r.status,
    createdAt: r.created_at,
  }));
}

export async function markAccessRequest(
  id: string,
  status: 'approved' | 'rejected',
  note?: string,
): Promise<{ ok: boolean; message?: string }> {
  const { data: auth } = await supabase.auth.getUser();
  const { error } = await supabase
    .from('access_requests')
    .update({
      status,
      decision_note: note?.trim() || null,
      decided_by: auth.user?.id ?? null,
      decided_at: new Date().toISOString(),
    })
    .eq('id', id);
  if (error) return { ok: false, message: error.message };
  return { ok: true };
}
