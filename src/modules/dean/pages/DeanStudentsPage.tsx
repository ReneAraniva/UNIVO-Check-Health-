import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { format } from 'date-fns';
import { ArrowUpDown, CheckCircle2, Download, Loader2 } from 'lucide-react';
import { useDeanStore } from '@/modules/dean/store/useDeanStore';
import { validateAttendance } from '@/shared/backend/checkHealthBackend';
import type { DeanStudent } from '@/modules/dean/types';
import { Button } from '@/shared/components/ui/button';
import { Input } from '@/shared/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/shared/components/ui/select';
import { Badge } from '@/shared/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/shared/components/ui/dialog';
import { PageHeader } from '@/shared/components/PageHeader';
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent,
  DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator,
} from '@/shared/components/ui/dropdown-menu';
import { toast } from 'sonner';
import { fetchCycleRecords, exportCycleCsv, exportCycleJson } from '@/modules/dean/services/cycleExport.service';
import { downloadCsv, toCsv } from '@/shared/utils/csv';

const PAGE_SIZE = 10;

export function DeanStudentsPage() {
  const { students, locations, filters, isLoading, loadData, setFilter, selectedStudent, setSelectedStudent } = useDeanStore();
  const [params] = useSearchParams();
  const [sortBy, setSortBy] = useState<keyof DeanStudent>('fullName');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [page, setPage] = useState(1);
  const [exporting, setExporting] = useState(false);

  const handleCycleExport = async (fmt: 'csv' | 'json') => {
    setExporting(true);
    try {
      const records = await fetchCycleRecords(filters.period);
      if (records.length === 0) { toast.error('No hay datos del ciclo para exportar.'); return; }
      if (fmt === 'csv') exportCycleCsv(records, filters.period);
      else exportCycleJson(records, filters.period);
      toast.success(`Ciclo exportado (${records.length} registros).`);
    } finally {
      setExporting(false);
    }
  };

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useEffect(() => {
    const status = params.get('status');
    if (status === 'at-risk') setFilter('status', 'at-risk');
  }, [params, setFilter]);

  useEffect(() => {
    const studentId = params.get('student');
    if (!studentId || students.length === 0) return;
    const student = students.find((row) => row.id === studentId);
    if (student) setSelectedStudent(student);
  }, [params, setSelectedStudent, students]);

  const filtered = useMemo(() => {
    let rows = students.filter((s) => {
      const searchOk = `${s.fullName} ${s.carnet}`.toLowerCase().includes(filters.search.toLowerCase());
      const sedeOk = filters.sede === 'all' || s.sedeId === filters.sede;
      const statusOk = filters.status === 'all' || s.status === filters.status;
      return searchOk && sedeOk && statusOk;
    });

    rows = [...rows].sort((a, b) => {
      const l = a[sortBy];
      const r = b[sortBy];
      if (typeof l === 'number' && typeof r === 'number') return sortDir === 'asc' ? l - r : r - l;
      return sortDir === 'asc' ? String(l).localeCompare(String(r)) : String(r).localeCompare(String(l));
    });
    return rows;
  }, [filters, students, sortBy, sortDir]);

  const paged = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));

  const toggleSort = (field: keyof DeanStudent) => {
    if (sortBy === field) setSortDir((prev) => (prev === 'asc' ? 'desc' : 'asc'));
    else { setSortBy(field); setSortDir('asc'); }
  };

  // Validar una asistencia observada desde el detalle del alumno (#review_status).
  // Optimista en el modal + recarga en segundo plano del store.
  const handleValidateAttendance = async (attendanceId: string) => {
    const res = await validateAttendance(attendanceId);
    if (!res.ok) { toast.error(res.message ?? 'No se pudo validar la asistencia.'); return; }
    toast.success('Asistencia validada');
    if (selectedStudent) {
      setSelectedStudent({
        ...selectedStudent,
        attendances: selectedStudent.attendances.map((a) =>
          a.id === attendanceId ? { ...a, status: 'valid' } : a),
      });
    }
    void loadData();
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64 gap-2 text-gray-500">
        <Loader2 className="w-5 h-5 animate-spin" />
        <span>Cargando alumnos…</span>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PageHeader title="Alumnos" description="Consulta avance, cumplimiento y estado de los estudiantes en prácticas." />

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-6">
        <Input
          placeholder="Buscar por nombre o carnet"
          value={filters.search}
          onChange={(e) => { setFilter('search', e.target.value); setPage(1); }}
          className="xl:col-span-2"
        />
        <Select value={filters.sede} onValueChange={(v) => { setFilter('sede', v); setPage(1); }}>
          <SelectTrigger><SelectValue placeholder="Sede" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todas las sedes</SelectItem>
            {locations.map((l) => <SelectItem key={l.id} value={l.id}>{l.name}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={filters.status} onValueChange={(v: any) => { setFilter('status', v); setPage(1); }}>
          <SelectTrigger><SelectValue placeholder="Estado" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos</SelectItem>
            <SelectItem value="at-risk">En riesgo (&lt;60%)</SelectItem>
            <SelectItem value="in-progress">En progreso (60-85%)</SelectItem>
            <SelectItem value="completed">Completado (&gt;85%)</SelectItem>
          </SelectContent>
        </Select>
        <Select value={filters.period} onValueChange={(v) => setFilter('period', v)}>
          <SelectTrigger><SelectValue placeholder="Período" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="2026-1">2026-1 (actual)</SelectItem>
            <SelectItem value="2025-2">2025-2</SelectItem>
          </SelectContent>
        </Select>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" disabled={exporting}>
              {exporting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />}
              Exportar
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel>Lista actual</DropdownMenuLabel>
            <DropdownMenuItem onClick={() => exportCSV(filtered)}>
              <Download className="mr-2 h-4 w-4" />CSV de la lista filtrada
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Ciclo completo (sistemas externos)</DropdownMenuLabel>
            <DropdownMenuItem disabled={exporting} onClick={() => void handleCycleExport('csv')}>
              <Download className="mr-2 h-4 w-4" />Asistencias del ciclo · CSV
            </DropdownMenuItem>
            <DropdownMenuItem disabled={exporting} onClick={() => void handleCycleExport('json')}>
              <Download className="mr-2 h-4 w-4" />Asistencias del ciclo · JSON
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <p className="text-sm text-gray-600">
        Mostrando {paged.length} de {filtered.length} alumnos ({students.length} total)
      </p>

      <div className="overflow-x-auto rounded-lg border bg-white">
        <table className="w-full min-w-[1100px] text-sm">
          <thead className="bg-gray-50">
            <tr>
              {[
                { label: '#', field: null },
                { label: 'Carnet', field: 'carnet' },
                { label: 'Nombre completo', field: 'fullName' },
                { label: 'Carrera', field: 'career' },
                { label: 'Sede', field: 'sedeName' },
                { label: 'Doctor', field: 'doctorName' },
                { label: 'Horas', field: 'completedHours' },
                { label: 'Meta', field: 'goalHours' },
                { label: '% Cumplimiento', field: 'compliancePercentage' },
                { label: 'Faltas', field: 'absences' },
                { label: 'Estado', field: null },
                { label: 'Acciones', field: null },
              ].map(({ label, field }) => (
                <th key={label} className="px-3 py-2 text-left font-medium text-gray-600">
                  {field ? (
                    <button onClick={() => toggleSort(field as keyof DeanStudent)} className="inline-flex items-center gap-1">
                      {label}<ArrowUpDown className="h-3.5 w-3.5" />
                    </button>
                  ) : label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {paged.length === 0 ? (
              <tr><td colSpan={12} className="px-3 py-8 text-center text-gray-400">Sin resultados</td></tr>
            ) : (
              paged.map((s, idx) => (
                <tr key={s.id} className="border-t hover:bg-gray-50 transition-colors">
                  <td className="px-3 py-2 text-gray-500">{(page - 1) * PAGE_SIZE + idx + 1}</td>
                  <td className="px-3 py-2 font-mono text-xs">{s.carnet}</td>
                  <td className="px-3 py-2 font-medium">{s.fullName}</td>
                  <td className="px-3 py-2 text-gray-600">{s.career}</td>
                  <td className="px-3 py-2 text-gray-600">{s.sedeName}</td>
                  <td className="px-3 py-2 text-gray-600">{s.doctorName}</td>
                  <td className="px-3 py-2">{s.completedHours}</td>
                  <td className="px-3 py-2 text-gray-500">{s.goalHours}</td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <div className="h-2 w-20 overflow-hidden rounded bg-gray-200">
                        <div
                          className={`h-full ${s.compliancePercentage > 85 ? 'bg-green-600' : s.compliancePercentage >= 60 ? 'bg-amber-500' : 'bg-red-600'}`}
                          style={{ width: `${s.compliancePercentage}%` }}
                        />
                      </div>
                      <span className={s.compliancePercentage > 85 ? 'text-green-700' : s.compliancePercentage >= 60 ? 'text-amber-700' : 'text-red-700'}>
                        {s.compliancePercentage}%
                      </span>
                    </div>
                  </td>
                  <td className="px-3 py-2">{s.absences}</td>
                  <td className="px-3 py-2"><StatusBadge status={s.status} /></td>
                  <td className="px-3 py-2">
                    <Button size="sm" variant="outline" onClick={() => setSelectedStudent(s)}>Ver detalle</Button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between">
        <span className="text-sm text-gray-600">Página {page} de {totalPages}</span>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Anterior</Button>
          <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>Siguiente</Button>
        </div>
      </div>

      <StudentDetailModal student={selectedStudent} onClose={() => setSelectedStudent(null)} onValidate={handleValidateAttendance} />
    </div>
  );
}

function exportCSV(students: DeanStudent[]) {
  const header = ['Carnet', 'Nombre', 'Carrera', 'Sede', 'Horas', 'Meta', '% Cumplimiento', 'Faltas', 'Estado'];
  const rows = students.map((s) => [
    s.carnet, s.fullName, s.career, s.sedeName,
    s.completedHours, s.goalHours, s.compliancePercentage, s.absences, s.status,
  ]);
  downloadCsv(toCsv(header, rows), `alumnos_${new Date().toISOString().slice(0, 10)}.csv`);
}

function StatusBadge({ status }: { status: DeanStudent['status'] }) {
  if (status === 'at-risk') return <Badge className="bg-red-100 text-red-700">En riesgo</Badge>;
  if (status === 'completed') return <Badge className="bg-green-100 text-green-700">Completado</Badge>;
  return <Badge className="bg-amber-100 text-amber-700">En progreso</Badge>;
}

function StudentDetailModal({ student, onClose, onValidate }: { student: DeanStudent | null; onClose: () => void; onValidate: (attendanceId: string) => void }) {
  const monthDays = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
  const attendanceMap = new Map(student?.attendances.map((a) => [Number(a.date.slice(-2)), a.status]));

  return (
    <Dialog open={Boolean(student)} onOpenChange={onClose}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        {student && (
          <>
            <DialogHeader>
              <DialogTitle>{student.fullName} — {student.carnet}</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 text-sm">
              <p><span className="font-semibold">Carrera:</span> {student.career}</p>
              <p><span className="font-semibold">Sede asignada:</span> {student.sedeName}</p>
              <p><span className="font-semibold">Encargado de sede:</span> {student.doctorName}</p>
              <p><span className="font-semibold">Docente:</span> {student.teacherName} · <span className="font-semibold">Coordinador:</span> {student.coordinatorName}</p>

              <div className="grid gap-3 md:grid-cols-4">
                <Info label="Horas" value={student.completedHours} />
                <Info label="Meta" value={student.goalHours} />
                <Info label="% Cumplimiento" value={`${student.compliancePercentage}%`} />
                <Info label="Faltas" value={student.absences} />
              </div>

              <div>
                <div className="mb-1 flex justify-between text-xs text-gray-600">
                  <span>Progreso</span><span>{student.compliancePercentage}%</span>
                </div>
                <div className="h-3 w-full rounded bg-gray-200">
                  <div
                    className={`h-full rounded ${student.compliancePercentage > 85 ? 'bg-green-600' : student.compliancePercentage >= 60 ? 'bg-amber-500' : 'bg-red-600'}`}
                    style={{ width: `${student.compliancePercentage}%` }}
                  />
                </div>
              </div>

              <div>
                <p className="mb-2 font-semibold">Calendario del mes</p>
                <div className="grid grid-cols-7 gap-1">
                  {Array.from({ length: monthDays }).map((_, idx) => {
                    const day = idx + 1;
                    const status = attendanceMap.get(day);
                    return (
                      <div
                        key={day}
                        className={`flex h-8 items-center justify-center rounded text-xs ${
                          status === 'valid' ? 'bg-green-100 text-green-700'
                          : status === 'review' ? 'bg-amber-100 text-amber-700'
                          : status === 'absent' ? 'bg-red-100 text-red-700'
                          : 'bg-gray-100 text-gray-500'
                        }`}
                      >
                        {day}
                      </div>
                    );
                  })}
                </div>
              </div>

              <div>
                <p className="mb-2 font-semibold">Últimas 10 asistencias</p>
                {student.attendances.length === 0 ? (
                  <p className="text-gray-400 text-xs">Sin registros</p>
                ) : (
                  <div className="space-y-2">
                    {student.attendances.slice(0, 10).map((a) => (
                      <div key={a.id} className="flex items-center justify-between gap-2 rounded border px-3 py-2">
                        <span>{format(new Date(a.date), 'dd/MM/yyyy')} {a.checkInTime} — {a.sedeName}</span>
                        <div className="flex items-center gap-2 shrink-0">
                          <Badge className={
                            a.status === 'valid' ? 'bg-green-100 text-green-700'
                            : a.status === 'review' ? 'bg-amber-100 text-amber-700'
                            : 'bg-red-100 text-red-700'
                          }>
                            {a.status === 'valid' ? 'Válida' : a.status === 'review' ? 'En revisión' : 'Falta'}
                          </Badge>
                          {a.status === 'review' && (
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 text-green-700 border-green-200 hover:bg-green-50"
                              onClick={() => onValidate(a.id)}
                            >
                              <CheckCircle2 className="w-3.5 h-3.5 mr-1" />Validar
                            </Button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Info({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded border p-2">
      <p className="text-xs text-gray-500">{label}</p>
      <p className="text-base font-semibold">{value}</p>
    </div>
  );
}
