import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { AlertTriangle, Building2, CalendarDays, Clock, Compass, Download, FileText, Loader2, MapPin, MapPinned, Pencil, Phone, Plus, QrCode, Radio, RefreshCw, Search, Stethoscope, Timer, Trash2 } from 'lucide-react';
import { useDeanStore } from '@/modules/dean/store/useDeanStore';
import type { Location } from '@/modules/dean/types';
import { createCampus, updateCampus, deleteCampus, toggleCampusActive, type CampusFormData } from '@/modules/dean/services/dean.service';
import { Input } from '@/shared/components/ui/input';
import { Label } from '@/shared/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/shared/components/ui/select';
import { Badge } from '@/shared/components/ui/badge';
import { Button } from '@/shared/components/ui/button';
import { Switch } from '@/shared/components/ui/switch';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/shared/components/ui/dialog';
import { CoordinatePicker } from '@/shared/components/CoordinatePicker';
import { HelpTooltip } from '@/shared/components/HelpTooltip';
import { PageHeader } from '@/shared/components/PageHeader';
import { toast } from 'sonner';
import { supabase } from '@/shared/backend/supabaseClient';
import { canonicalRole, type CanonicalRole } from '@/shared/utils/roles';

const EMPTY_FORM: CampusFormData = {
  name: '', latitude: '', longitude: '', radius_meters: '100',
  location_label: '', supervisor_name: '', supervisor_phone: '',
  schedule: '', start_date: '', end_date: '', description: '',
  check_in_from: '', check_in_to: '', max_students: '',
};

type QrModal = {
  campusId: string;
  campusName: string;
  qrDataUrl: string;
  shortCode: string;
};

export function DeanLocationsPage() {
  const { locations, isLoading, loadData, setSelectedLocation, selectedLocation } = useDeanStore();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'inactive'>('all');
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<CampusFormData>(EMPTY_FORM);
  const [isSaving, setIsSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Location | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteBlocked, setDeleteBlocked] = useState(false);
  const [qrModal, setQrModal] = useState<QrModal | null>(null);
  const [generatingQrId, setGeneratingQrId] = useState<string | null>(null);
  const [confirmRegenerate, setConfirmRegenerate] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [currentRole, setCurrentRole] = useState<CanonicalRole | null>(null);
  const canManageCampuses = currentRole === 'ADMIN';

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useEffect(() => {
    void supabase.auth.getUser().then(async ({ data: auth }) => {
      if (!auth.user?.id) return;
      const { data } = await supabase
        .from('users')
        .select('role')
        .eq('id', auth.user.id)
        .single<{ role: string }>();
      setCurrentRole(canonicalRole(data?.role));
    });
  }, []);

  const filtered = useMemo(
    () =>
      locations.filter(
        (l) =>
          l.name.toLowerCase().includes(search.toLowerCase()) &&
          (statusFilter === 'all' || l.status === statusFilter),
      ),
    [locations, search, statusFilter],
  );

  const openCreate = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setShowForm(true);
  };

  const openEdit = (l: Location) => {
    setEditingId(l.id);
    setForm({
      name: l.name,
      latitude: String(l.coordinates.lat),
      longitude: String(l.coordinates.lng),
      radius_meters: String(l.allowedRadiusMeters),
      location_label: l.address,
      supervisor_name: l.doctorName === '—' ? '' : l.doctorName,
      supervisor_phone: l.doctorPhone ?? '',
      schedule: l.schedule ?? '',
      start_date: l.startDate ?? '',
      end_date: l.endDate ?? '',
      description: l.description ?? '',
      check_in_from: l.checkInFrom ?? '',
      check_in_to: l.checkInTo ?? '',
      max_students: l.maxStudents != null ? String(l.maxStudents) : '',
    });
    setShowForm(true);
  };

  const handleSave = async (e: FormEvent) => {
    e.preventDefault();
    if (!form.name.trim() || !form.latitude || !form.longitude) {
      toast.error('Nombre, latitud y longitud son obligatorios');
      return;
    }
    setIsSaving(true);
    const result = editingId
      ? await updateCampus(editingId, form)
      : await createCampus(form);
    setIsSaving(false);
    if (!result.ok) {
      toast.error(result.message ?? 'Error al guardar la sede');
      return;
    }
    toast.success(editingId ? 'Sede actualizada' : 'Sede creada');
    setShowForm(false);
    void loadData();
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setIsDeleting(true);
    const result = await deleteCampus(deleteTarget.id);
    setIsDeleting(false);
    if (!result.ok) {
      // Si la sede tiene historial (FK), no es error fatal: el diálogo muta para
      // ofrecer desactivarla en su lugar.
      if (result.blocked) { setDeleteBlocked(true); return; }
      toast.error(result.message ?? 'No se pudo eliminar la sede');
      return;
    }
    toast.success('Sede eliminada');
    setDeleteTarget(null);
    void loadData();
  };

  // Desactivar la sede desde el diálogo de eliminación bloqueada (conserva el historial).
  const handleDeactivateFromDialog = async () => {
    if (!deleteTarget) return;
    setIsDeleting(true);
    const result = await toggleCampusActive(deleteTarget.id, false);
    setIsDeleting(false);
    if (!result.ok) { toast.error(result.message ?? 'No se pudo desactivar la sede'); return; }
    toast.success(`${deleteTarget.name} desactivada`);
    setDeleteTarget(null);
    void loadData();
  };

  const set = (field: keyof CampusFormData) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm((prev) => ({ ...prev, [field]: e.target.value }));

  const handleGenerateQr = async (campusId: string, campusName: string, regenerate = false) => {
    setGeneratingQrId(campusId);
    const { data, error } = await supabase.functions.invoke('generate-campus-qr', {
      body: { campus_id: campusId, regenerate },
    });
    setGeneratingQrId(null);
    setConfirmRegenerate(false);
    if (error || !data?.qr_data_url) {
      toast.error(data?.error ?? 'No se pudo generar el QR. Verifica la configuración del servidor.');
      return;
    }
    if (regenerate) toast.success('QR regenerado. El QR y el código anteriores ya no funcionan.');
    setQrModal({ campusId, campusName, qrDataUrl: data.qr_data_url, shortCode: data.short_code ?? '' });
  };

  const handleToggleActive = async (l: Location) => {
    setTogglingId(l.id);
    const result = await toggleCampusActive(l.id, l.status === 'inactive');
    setTogglingId(null);
    if (!result.ok) { toast.error(result.message ?? 'Error al cambiar estado'); return; }
    toast.success(l.status === 'active' ? `${l.name} desactivada` : `${l.name} activada`);
    void loadData();
  };

  // Descarga el QR como una HOJA imprimible (proporción A4) decorada: cabecera de
  // marca, nombre de la sede, QR enmarcado, código corto grande e instrucciones.
  const handleDownloadQr = () => {
    if (!qrModal) return;

    const W = 1000, H = 1414; // ~A4 vertical
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const brand = '#102141';
    ctx.textAlign = 'center';

    const wrap = (text: string, maxWidth: number): string[] => {
      const words = text.split(' ');
      const lines: string[] = [];
      let current = '';
      for (const word of words) {
        const test = current ? `${current} ${word}` : word;
        if (ctx.measureText(test).width > maxWidth && current) { lines.push(current); current = word; }
        else { current = test; }
      }
      if (current) lines.push(current);
      return lines;
    };

    // Fondo + marco exterior
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = '#e2e8f0'; ctx.lineWidth = 4; ctx.strokeRect(20, 20, W - 40, H - 40);

    // Cabecera de marca
    ctx.fillStyle = brand; ctx.fillRect(20, 20, W - 40, 150);
    ctx.fillStyle = '#ffffff'; ctx.font = 'bold 46px "Nunito Sans", sans-serif';
    ctx.fillText('UNIVO Check-Health', W / 2, 98);
    ctx.fillStyle = '#c7d2fe'; ctx.font = '24px "Nunito Sans", sans-serif';
    ctx.fillText('Registro de asistencia · Área de Salud', W / 2, 138);

    // Nombre de la sede
    ctx.fillStyle = '#0f172a'; ctx.font = 'bold 40px "Nunito Sans", sans-serif';
    let y = 248;
    for (const line of wrap(qrModal.campusName, W - 140)) { ctx.fillText(line, W / 2, y); y += 50; }

    const img = new Image();
    img.onload = () => {
      const qrSize = 600;
      const qx = (W - qrSize) / 2;
      const qy = Math.max(y + 20, 320);
      ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 2;
      ctx.strokeRect(qx - 16, qy - 16, qrSize + 32, qrSize + 32);
      ctx.drawImage(img, qx, qy, qrSize, qrSize);

      let cy = qy + qrSize + 80;
      if (qrModal.shortCode) {
        ctx.fillStyle = '#64748b'; ctx.font = '24px "Nunito Sans", sans-serif';
        ctx.fillText('Código manual (sin cámara)', W / 2, cy); cy += 66;
        ctx.fillStyle = '#0f172a'; ctx.font = 'bold 70px monospace';
        ctx.fillText(qrModal.shortCode.split('').join(' '), W / 2, cy); cy += 50;
      }

      ctx.fillStyle = '#475569'; ctx.font = '24px "Nunito Sans", sans-serif';
      cy += 24;
      const instr = 'QR fijo de la sede: imprímelo y reutilízalo. El alumno lo escanea o ingresa el código; la validación depende de su ubicación y horario.';
      for (const line of wrap(instr, W - 160)) { ctx.fillText(line, W / 2, cy); cy += 34; }

      ctx.fillStyle = '#94a3b8'; ctx.font = '20px "Nunito Sans", sans-serif';
      ctx.fillText('Generado por UNIVO Check-Health', W / 2, H - 48);

      const a = document.createElement('a');
      a.href = canvas.toDataURL('image/png');
      a.download = `qr_${qrModal.campusName.replace(/\s+/g, '_')}.png`;
      a.click();
    };
    img.src = qrModal.qrDataUrl;
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64 gap-2 text-gray-500">
        <Loader2 className="w-5 h-5 animate-spin" />
        <span>Cargando sedes…</span>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Sedes"
        description={canManageCampuses ? 'Administra ubicaciones, radios GPS, encargados y QR de registro.' : 'Consulta tus sedes asignadas y genera el QR o código manual de asistencia.'}
        action={canManageCampuses ? (
          <Button onClick={openCreate} className="bg-white/10 border border-white/20 text-white hover:bg-white/20">
            <Plus className="w-4 h-4 mr-1.5" />Nueva sede
          </Button>
        ) : undefined}
      />

      <div className="grid gap-3 md:grid-cols-3">
        <div className="relative md:col-span-2">
          <Search className="absolute left-3 top-3.5 h-4 w-4 text-brand-400" />
          <Input className="pl-9" placeholder="Buscar sede" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <Select value={statusFilter} onValueChange={(v: any) => setStatusFilter(v)}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todas</SelectItem>
            <SelectItem value="active">Activas</SelectItem>
            <SelectItem value="inactive">Inactivas</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <p className="text-sm text-gray-600">
        {locations.filter((l) => l.status === 'active').length} sedes activas · {filtered.length} mostradas
      </p>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {filtered.length === 0 ? (
          <p className="text-sm text-gray-400 col-span-3 text-center py-12">Sin sedes registradas</p>
        ) : (
          filtered.map((l) => (
            <div key={l.id} className="rounded-lg border bg-white p-4 space-y-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="font-semibold text-gray-900">{l.name}</p>
                  <p className="text-xs text-gray-500 flex items-center gap-1 mt-0.5">
                    <MapPin className="w-3 h-3" />{l.address}
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Badge className={l.status === 'active' ? 'bg-green-100 text-green-700' : 'bg-gray-200 text-gray-600'}>
                    {l.status === 'active' ? 'Activa' : 'Inactiva'}
                  </Badge>
                  {canManageCampuses && (
                    togglingId === l.id
                      ? <Loader2 className="w-4 h-4 animate-spin text-gray-400" />
                      : (
                        <Switch
                          checked={l.status === 'active'}
                          onCheckedChange={() => void handleToggleActive(l)}
                          aria-label={l.status === 'active' ? 'Desactivar sede' : 'Activar sede'}
                        />
                      )
                  )}
                </div>
              </div>

              <div className="space-y-1 text-sm text-gray-700">
                {l.doctorName !== '—' && <p>Supervisor: {l.doctorName}</p>}
                {l.doctorPhone && <p className="text-xs text-gray-500">{l.doctorPhone}</p>}
                {l.schedule && <p className="text-xs text-gray-500">{l.schedule}</p>}
                <p>Radio GPS: {l.allowedRadiusMeters} m</p>
                <p>Alumnos asignados: {l.totalStudents}</p>
              </div>

              {l.totalStudents > 0 && (
                <div>
                  <div className="mb-1 flex justify-between text-xs text-gray-500">
                    <span>Cumplimiento</span><span>{l.averageCompliance}%</span>
                  </div>
                  <div className="h-2 rounded bg-gray-200">
                    <div
                      className={`h-full rounded ${l.averageCompliance > 75 ? 'bg-green-500' : l.averageCompliance >= 50 ? 'bg-amber-500' : 'bg-red-500'}`}
                      style={{ width: `${l.averageCompliance}%` }}
                    />
                  </div>
                </div>
              )}

              <div className="flex gap-2 pt-1">
                <Button className="flex-1" variant="outline" size="sm" onClick={() => setSelectedLocation(l)}>
                  Ver detalle
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  title="Generar QR de la sede (estático, imprimible)"
                  disabled={generatingQrId === l.id}
                  onClick={() => void handleGenerateQr(l.id, l.name)}
                >
                  {generatingQrId === l.id
                    ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    : <QrCode className="w-3.5 h-3.5" />}
                </Button>
                {canManageCampuses && (
                  <>
                    <Button variant="outline" size="sm" onClick={() => openEdit(l)}>
                      <Pencil className="w-3.5 h-3.5" />
                    </Button>
                    <Button variant="outline" size="sm" className="text-red-600 hover:text-red-700 hover:bg-red-50" onClick={() => { setDeleteBlocked(false); setDeleteTarget(l); }}>
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      {/* Modal crear/editar sede — T-07.3 */}
      <Dialog open={showForm} onOpenChange={(open) => !isSaving && setShowForm(open)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {editingId ? <Pencil className="h-5 w-5 text-brand-700" /> : <Building2 className="h-5 w-5 text-brand-700" />}
              {editingId ? 'Editar sede' : 'Nueva sede'}
            </DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSave} className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-2">
            <div className="sm:col-span-2 space-y-1.5">
              <Label className="text-xs uppercase tracking-wide text-brand-700"><Building2 className="h-3.5 w-3.5" />Nombre de la sede *</Label>
              <Input value={form.name} onChange={set('name')} placeholder="Hospital Nacional Rosales" required />
            </div>
            <div className="sm:col-span-2 space-y-1.5">
              <Label className="text-xs uppercase tracking-wide text-brand-700 flex items-center gap-1">
                <MapPin className="h-3.5 w-3.5" />Ubicación en el mapa
                <HelpTooltip text="Busca el hospital por su nombre y departamento (ej. 'Hospital San Juan de Dios, San Miguel') para ubicarlo con precisión. También puedes hacer clic en el punto exacto o arrastrar el marcador. No necesitas conocer las coordenadas: se llenan abajo automáticamente." />
              </Label>
              <CoordinatePicker
                lat={form.latitude}
                lng={form.longitude}
                onChange={(la, ln) => setForm((prev) => ({ ...prev, latitude: la, longitude: ln }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs uppercase tracking-wide text-brand-700"><MapPin className="h-3.5 w-3.5" />Latitud *</Label>
              <Input value={form.latitude} onChange={set('latitude')} placeholder="13.7013" type="number" step="any" required />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs uppercase tracking-wide text-brand-700"><Compass className="h-3.5 w-3.5" />Longitud *</Label>
              <Input value={form.longitude} onChange={set('longitude')} placeholder="-89.2045" type="number" step="any" required />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs uppercase tracking-wide text-brand-700 flex items-center gap-1">
                <Radio className="h-3.5 w-3.5" />Radio GPS (metros, mín. 50)
                <HelpTooltip text="Distancia máxima desde el punto de la sede en la que se acepta el check-in del alumno. Un radio menor (30–50 m) es más estricto contra ubicaciones falsas." />
              </Label>
              <Input value={form.radius_meters} onChange={set('radius_meters')} placeholder="100" type="number" min="50" max="1000" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs uppercase tracking-wide text-brand-700 flex items-center gap-1">
                <Stethoscope className="h-3.5 w-3.5" />Cupo máximo de estudiantes
                <HelpTooltip text="Número máximo de alumnos que la sede puede recibir por período. Al asignar se bloquea si se supera. Déjalo vacío para no limitar." />
              </Label>
              <Input value={form.max_students} onChange={set('max_students')} placeholder="Sin límite" type="number" min="1" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs uppercase tracking-wide text-brand-700"><MapPinned className="h-3.5 w-3.5" />Dirección / Etiqueta</Label>
              <Input value={form.location_label} onChange={set('location_label')} placeholder="Hospital Nacional Rosales, SS" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs uppercase tracking-wide text-brand-700 flex items-center gap-1"><Stethoscope className="h-3.5 w-3.5" />Encargado de referencia (opcional)
                <HelpTooltip text="Contacto de referencia para mostrar en la sede. Los encargados REALES (con acceso a la app y al módulo de su sede) se crean como usuarios con rol «Representante hospitalario» en Gestión de usuarios, y una sede puede tener varios." />
              </Label>
              <Input value={form.supervisor_name} onChange={set('supervisor_name')} placeholder="Dr. Roberto Martínez" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs uppercase tracking-wide text-brand-700"><Phone className="h-3.5 w-3.5" />Teléfono de referencia</Label>
              <Input value={form.supervisor_phone} onChange={set('supervisor_phone')} placeholder="2222-3333" />
            </div>
            <div className="sm:col-span-2 space-y-1.5">
              <Label className="text-xs uppercase tracking-wide text-brand-700"><Clock className="h-3.5 w-3.5" />Horario</Label>
              <Input value={form.schedule} onChange={set('schedule')} placeholder="Lunes a Viernes, 7:00 AM - 3:00 PM" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs uppercase tracking-wide text-brand-700"><CalendarDays className="h-3.5 w-3.5" />Fecha inicio</Label>
              <Input value={form.start_date} onChange={set('start_date')} type="date" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs uppercase tracking-wide text-brand-700"><CalendarDays className="h-3.5 w-3.5" />Fecha fin</Label>
              <Input value={form.end_date} onChange={set('end_date')} type="date" />
            </div>
            <div className="sm:col-span-2 space-y-1.5">
              <Label className="text-xs uppercase tracking-wide text-brand-700"><FileText className="h-3.5 w-3.5" />Descripción</Label>
              <Input value={form.description} onChange={set('description')} placeholder="Descripción breve de la práctica…" />
            </div>
            <div className="sm:col-span-2">
              <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2 flex items-center gap-1">
                Ventana horaria de check-in (opcional)
                <HelpTooltip text="Franja del día en que se acepta el check-in en esta sede. Es un límite general; el horario fino por alumno y día se define en Asignaciones. Si la dejas vacía, no hay restricción de hora." />
              </p>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label className="text-xs text-brand-700"><Timer className="h-3.5 w-3.5" />Hora inicio</Label>
                  <Input value={form.check_in_from} onChange={set('check_in_from')} type="time" placeholder="07:00" />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-brand-700"><Timer className="h-3.5 w-3.5" />Hora fin</Label>
                  <Input value={form.check_in_to} onChange={set('check_in_to')} type="time" placeholder="09:00" />
                </div>
              </div>
              <p className="text-xs text-gray-400 mt-1">Si no se configura, no hay restricción horaria.</p>
            </div>
            <div className="sm:col-span-2 flex justify-end gap-2 pt-2">
              <Button type="button" variant="outline" disabled={isSaving} onClick={() => setShowForm(false)}>Cancelar</Button>
              <Button type="submit" disabled={isSaving} className="bg-brand-700 hover:bg-brand-800 text-white">
                {isSaving ? <Loader2 className="w-4 h-4 animate-spin mr-1.5" /> : null}
                {editingId ? 'Guardar cambios' : 'Crear sede'}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* Confirmación de eliminación */}
      <Dialog open={Boolean(deleteTarget)} onOpenChange={(open) => { if (!open) { setDeleteTarget(null); setDeleteBlocked(false); } }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {deleteBlocked
                ? <><AlertTriangle className="h-5 w-5 text-amber-600" />No se puede eliminar</>
                : <><Trash2 className="h-5 w-5 text-red-600" />Eliminar sede</>}
            </DialogTitle>
          </DialogHeader>
          {deleteBlocked ? (
            <>
              <p className="text-sm text-gray-700">
                <strong>{deleteTarget?.name}</strong> tiene asistencias o asignaciones registradas, por lo que
                no puede eliminarse (el historial es inmutable). Puedes <strong>desactivarla</strong> para
                ocultarla sin perder los registros.
              </p>
              <div className="flex justify-end gap-2 pt-2">
                <Button variant="outline" onClick={() => { setDeleteTarget(null); setDeleteBlocked(false); }} disabled={isDeleting}>Cancelar</Button>
                <Button className="bg-amber-600 hover:bg-amber-700 text-white" onClick={handleDeactivateFromDialog} disabled={isDeleting}>
                  {isDeleting ? <Loader2 className="w-4 h-4 animate-spin mr-1.5" /> : null}
                  Desactivar sede
                </Button>
              </div>
            </>
          ) : (
            <>
              <p className="text-sm text-gray-700">
                ¿Seguro que deseas eliminar <strong>{deleteTarget?.name}</strong>?
                Esta acción no se puede deshacer.
              </p>
              <div className="flex justify-end gap-2 pt-2">
                <Button variant="outline" onClick={() => setDeleteTarget(null)} disabled={isDeleting}>Cancelar</Button>
                <Button className="bg-red-600 hover:bg-red-700 text-white" onClick={handleDelete} disabled={isDeleting}>
                  {isDeleting ? <Loader2 className="w-4 h-4 animate-spin mr-1.5" /> : null}
                  Eliminar
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Modal detalle de sede */}
      <LocationDetailModal location={selectedLocation} onClose={() => setSelectedLocation(null)} />

      {/* Modal QR del día — T-08.1 */}
      <Dialog
        open={Boolean(qrModal)}
        onOpenChange={(open) => {
          if (!open) {
            setQrModal(null);
            setConfirmRegenerate(false);
          }
        }}
      >
        <DialogContent className="sm:max-w-sm">
          {qrModal && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <QrCode className="w-4 h-4" /> QR de la sede — {qrModal.campusName}
                </DialogTitle>
              </DialogHeader>
              <div className="flex flex-col items-center gap-4 py-2">
                <img
                  src={qrModal.qrDataUrl}
                  alt={`QR ${qrModal.campusName}`}
                  className="rounded-lg border shadow-sm"
                  width={280}
                  height={280}
                />
                {qrModal.shortCode && (
                  <div className="text-center">
                    <p className="text-xs text-gray-500 mb-1">Código manual (sin cámara)</p>
                    <p className="text-3xl font-mono font-bold tracking-widest text-gray-900 select-all">
                      {qrModal.shortCode}
                    </p>
                  </div>
                )}
                <p className="text-xs text-gray-500 text-center">
                  QR fijo de la sede: <strong>imprímelo y reutilízalo</strong>.<br />
                  El alumno lo escanea o ingresa las 6 letras; la validación depende de su ubicación y horario.
                </p>
                <Button variant="outline" className="w-full" onClick={handleDownloadQr}>
                  <Download className="w-4 h-4 mr-2" />Descargar PNG
                </Button>
                {/* Revoca el QR impreso: útil si una foto del QR o el código se filtró. */}
                {confirmRegenerate ? (
                  <div className="w-full rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
                    <p className="mb-2">
                      El QR impreso y el código actual <strong>dejarán de funcionar</strong> de inmediato.
                      Tendrás que imprimir el nuevo.
                    </p>
                    <div className="flex gap-2">
                      <Button size="sm" variant="outline" className="flex-1" onClick={() => setConfirmRegenerate(false)}>
                        Cancelar
                      </Button>
                      <Button
                        size="sm"
                        className="flex-1"
                        disabled={generatingQrId === qrModal.campusId}
                        onClick={() => void handleGenerateQr(qrModal.campusId, qrModal.campusName, true)}
                      >
                        {generatingQrId === qrModal.campusId
                          ? <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                          : <RefreshCw className="w-4 h-4 mr-2" />}
                        Regenerar
                      </Button>
                    </div>
                  </div>
                ) : (
                  <Button variant="ghost" size="sm" className="w-full text-gray-600" onClick={() => setConfirmRegenerate(true)}>
                    <RefreshCw className="w-4 h-4 mr-2" />Regenerar QR (revoca el actual)
                  </Button>
                )}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function LocationDetailModal({ location, onClose }: { location: Location | null; onClose: () => void }) {
  // #8: encargados de la sede = usuarios con rol Representante ligados a esta sede
  // (users.campus_id). Una sede puede tener varios; se gestionan en Gestión de usuarios.
  const [reps, setReps] = useState<{ id: string; full_name: string | null; email: string }[]>([]);
  useEffect(() => {
    if (!location) { setReps([]); return; }
    void supabase
      .from('users')
      .select('id, full_name, email')
      .eq('role', 'REPRESENTATIVE')
      .eq('campus_id', location.id)
      .order('full_name')
      .then(({ data }) => setReps((data as { id: string; full_name: string | null; email: string }[]) ?? []));
  }, [location]);

  return (
    <Dialog open={Boolean(location)} onOpenChange={onClose}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-4xl">
        {location && (
          <>
            <DialogHeader><DialogTitle>{location.name}</DialogTitle></DialogHeader>
            <div className="space-y-4 text-sm">
              <p><span className="font-semibold">Dirección:</span> {location.address}</p>
              <p><span className="font-semibold">Coordenadas:</span> {location.coordinates.lat}, {location.coordinates.lng}</p>
              <p><span className="font-semibold">Radio permitido:</span> {location.allowedRadiusMeters} m</p>

              <div className="rounded-lg border border-brand-100 bg-brand-50/40 p-3">
                <p className="font-semibold text-brand-900">Encargados de la sede</p>
                {reps.length === 0 ? (
                  <p className="text-gray-500 mt-1">
                    {location.doctorName && location.doctorName !== '—'
                      ? <>Referencia: {location.doctorName}{location.doctorPhone ? ` · ${location.doctorPhone}` : ''}</>
                      : 'Sin encargados asignados.'}
                  </p>
                ) : (
                  <ul className="mt-1 space-y-0.5 text-gray-700">
                    {reps.map((r) => (
                      <li key={r.id} className="flex items-center gap-2">
                        <span className="inline-block w-1.5 h-1.5 rounded-full bg-brand-500" />
                        <span className="font-medium">{r.full_name ?? 'Sin nombre'}</span>
                        <span className="text-xs text-gray-500">{r.email}</span>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="text-xs text-gray-400 mt-2">
                  Para agregar otro encargado, crea un usuario con rol «Representante hospitalario» y asígnale esta sede en Gestión de usuarios.
                </p>
              </div>
              {location.schedule && <p><span className="font-semibold">Horario:</span> {location.schedule}</p>}
              {location.description && <p><span className="font-semibold">Descripción:</span> {location.description}</p>}

              <div className="h-48 overflow-hidden rounded border bg-gray-100">
                <iframe
                  title="mapa"
                  className="h-full w-full"
                  loading="lazy"
                  referrerPolicy="no-referrer-when-downgrade"
                  src={`https://maps.google.com/maps?q=${location.coordinates.lat},${location.coordinates.lng}&z=15&output=embed`}
                />
              </div>

              {location.students.length > 0 && (
                <div className="overflow-x-auto rounded border">
                  <table className="w-full min-w-[500px] text-sm">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-3 py-2 text-left">Carnet</th>
                        <th className="px-3 py-2 text-left">Nombre</th>
                        <th className="px-3 py-2 text-left">% Cumplimiento</th>
                        <th className="px-3 py-2 text-left">Estado</th>
                      </tr>
                    </thead>
                    <tbody>
                      {location.students.map((s) => (
                        <tr key={s.id} className="border-t">
                          <td className="px-3 py-2 font-mono text-xs">{s.carnet}</td>
                          <td className="px-3 py-2">{s.fullName}</td>
                          <td className="px-3 py-2">{s.compliancePercentage}%</td>
                          <td className="px-3 py-2">
                            {s.status === 'at-risk'
                              ? <Badge className="bg-red-100 text-red-700">En riesgo</Badge>
                              : s.status === 'completed'
                                ? <Badge className="bg-green-100 text-green-700">Completado</Badge>
                                : <Badge className="bg-amber-100 text-amber-700">En progreso</Badge>
                            }
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
