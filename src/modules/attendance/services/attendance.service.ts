import { supabase } from '@/shared/backend/supabaseClient';
import { Attendance, DeviceInfo, GeoPoint, GeoPointSample, MotionSensorSample } from '../types';
import { reportServiceError } from '@/shared/utils/sentry';

export const getDeviceInfo = (params?: {
  location?: GeoPoint | null;
  motionSamples?: MotionSensorSample[];
  locationSamples?: GeoPointSample[];
}): DeviceInfo => {
  const ua = navigator.userAgent;
  let browser = 'Desconocido';
  if (ua.includes('Chrome') && !ua.includes('Edg')) browser = 'Chrome';
  else if (ua.includes('Firefox')) browser = 'Firefox';
  else if (ua.includes('Safari') && !ua.includes('Chrome')) browser = 'Safari';
  else if (ua.includes('Edg')) browser = 'Edge';

  const nav = navigator as Navigator & { connection?: { effectiveType?: string } };
  const connectionType = nav.connection?.effectiveType ?? '';

  return {
    browser,
    gpsAccuracy: params?.location?.accuracyMeters ?? null,
    connectionType,
    motionSamples: params?.motionSamples,
    locationSamples: params?.locationSamples,
  };
};

export const getDeviceFingerprint = (): string => {
  const screenData = [
    window.screen.width,
    window.screen.height,
    window.screen.colorDepth,
    window.devicePixelRatio,
  ].join('x');
  const payload = `${navigator.userAgent}|${screenData}`;
  let hash = 0x811c9dc5;

  for (let index = 0; index < payload.length; index += 1) {
    hash ^= payload.charCodeAt(index);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }

  return `fp_${(hash >>> 0).toString(16).padStart(8, '0')}`;
};

const mapRow = (row: Record<string, unknown>): Attendance => ({
  id: row.id as string,
  studentId: row.student_id as string,
  practiceId: row.campus_id as string,
  checkIn: row.check_in as string,
  checkOut: (row.check_out as string) ?? undefined,
  date: row.date as string,
  status: row.status as Attendance['status'],
  notes: (row.notes as string) ?? undefined,
  checkInLocation: (row.check_in_location as Attendance['checkInLocation']) ?? undefined,
  checkOutLocation: (row.check_out_location as Attendance['checkOutLocation']) ?? undefined,
  securitySeal: (row.security_seal as string) ?? undefined,
  checkOutSecuritySeal: (row.check_out_security_seal as string) ?? undefined,
  workedHours: (row.worked_hours as number) ?? undefined,
  reviewStatus: (row.review_status as Attendance['reviewStatus']) ?? undefined,
  suspiciousReason: (row.suspicious_reason as string) ?? undefined,
  deviceId: (row.device_id as string) ?? undefined,
  deviceFingerprint: (row.device_fingerprint as string) ?? undefined,
  deviceInfo: (row.device_info as DeviceInfo) ?? undefined,
});

export const getAttendance = async (): Promise<Attendance[]> => {
  const { data, error } = await supabase.from('attendances').select('*');
  if (error) { reportServiceError('attendance.service.getAttendance', error); return []; }
  if (!data) return [];
  return data.map(mapRow);
};

export const getStudentAttendanceHistory = async (
  studentId: string,
  range: 'week' | 'month' | 'all',
  from: number,
  to: number,
): Promise<{ data: Attendance[]; count: number }> => {
  let query = supabase
    .from('attendances')
    .select('*', { count: 'exact' })
    .eq('student_id', studentId)
    .order('date', { ascending: false })
    .order('check_in', { ascending: false })
    .range(from, to);

  if (range !== 'all') {
    const days = range === 'week' ? 7 : 30;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    query = query.gte('date', since);
  }

  const { data, error, count } = await query;
  if (error || !data) return { data: [], count: 0 };
  return { data: data.map(mapRow), count: count ?? 0 };
};
