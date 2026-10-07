import { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/shared/components/ui/card';
import { Badge } from '@/shared/components/ui/badge';
import { Label } from '@/shared/components/ui/label';
import { Button } from '@/shared/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/shared/components/ui/select';
import { Download, Filter, FileText } from 'lucide-react';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { getStudents } from '@/modules/students/services/students.service';
import { getPractices } from '@/modules/practices/services/practices.service';
import { getAttendance } from '@/modules/attendance/services/attendance.service';
import type { AttendanceRecord } from '@/modules/attendance/types';
import type { Student } from '@/modules/students/types';
import type { Practice } from '@/modules/practices/types';
import { format } from 'date-fns';
import { PageHeader } from '@/shared/components/PageHeader';
import { downloadCsv, toCsv } from '@/shared/utils/csv';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/shared/components/ui/table';

export function Reports() {
  const [records, setRecords] = useState<AttendanceRecord[]>([]);
  const [students, setStudents] = useState<Student[]>([]);
  const [practices, setPractices] = useState<Practice[]>([]);
  const [filterStudent, setFilterStudent] = useState('all');
  const [filterPractice, setFilterPractice] = useState('all');
  const [filterStatus, setFilterStatus] = useState('all');

  useEffect(() => {
    const load = async () => {
      const [s, p, a] = await Promise.all([getStudents(), getPractices(), getAttendance()]);
      setStudents(s);
      setPractices(p);
      const mapped: AttendanceRecord[] = a
        .map((att) => ({
          ...att,
          studentName: s.find((x) => x.id === att.studentId)?.name ?? 'Desconocido',
          practiceName: p.find((x) => x.id === att.practiceId)?.name ?? 'Desconocido',
        }))
        .sort((a, b) => new Date(b.checkIn).getTime() - new Date(a.checkIn).getTime());
      setRecords(mapped);
    };
    void load();
  }, []);

  const filtered = records.filter((r) => {
    const byStudent = filterStudent === 'all' || r.studentId === filterStudent;
    const byPractice = filterPractice === 'all' || r.practiceId === filterPractice;
    const byStatus = filterStatus === 'all' || r.status === filterStatus;
    return byStudent && byPractice && byStatus;
  });

  const duration = (checkIn: string, checkOut?: string) => {
    if (!checkOut) return 'En curso';
    const ms = new Date(checkOut).getTime() - new Date(checkIn).getTime();
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    return `${h}h ${m}m`;
  };

  const statusBadge = (status: string) => {
    const map: Record<string, { cls: string; label: string }> = {
      present:  { cls: 'bg-green-100 text-green-800',  label: 'Presente' },
      late:     { cls: 'bg-yellow-100 text-yellow-800', label: 'Tardanza' },
      absent:   { cls: 'bg-red-100 text-red-800',      label: 'Ausente' },
      excused:  { cls: 'bg-brand-100 text-brand-800',    label: 'Justificado' },
    };
    const { cls, label } = map[status] ?? { cls: 'bg-gray-100 text-gray-700', label: status };
    return <Badge className={cls}>{label}</Badge>;
  };

  const exportCSV = () => {
    const header = ['Fecha', 'Estudiante', 'Práctica', 'Entrada', 'Salida', 'Duración', 'Estado'];
    const rows = filtered.map((r) => [
      format(new Date(r.date), 'dd/MM/yyyy'),
      r.studentName, r.practiceName,
      format(new Date(r.checkIn), 'HH:mm'),
      r.checkOut ? format(new Date(r.checkOut), 'HH:mm') : 'N/A',
      duration(r.checkIn, r.checkOut),
      r.status,
    ]);
    downloadCsv(toCsv(header, rows), `reporte-${format(new Date(), 'yyyy-MM-dd')}.csv`);
  };

  const exportPDF = () => {
    const doc = new jsPDF({ orientation: 'landscape' });
    const dateStr = format(new Date(), 'dd/MM/yyyy');

    doc.setFontSize(14);
    doc.setFont('helvetica', 'bold');
    doc.text('UNIVO Check-Health — Reporte de Asistencias', 14, 16);
    doc.setFontSize(9);
    doc.setFont('helvetica', 'normal');
    doc.text(`Generado: ${dateStr}  |  Registros: ${filtered.length}`, 14, 23);

    autoTable(doc, {
      startY: 28,
      head: [['Fecha', 'Estudiante', 'Práctica', 'Entrada', 'Salida', 'Duración', 'Estado']],
      body: filtered.map((r) => [
        format(new Date(r.date), 'dd/MM/yyyy'),
        r.studentName,
        r.practiceName,
        format(new Date(r.checkIn), 'HH:mm'),
        r.checkOut ? format(new Date(r.checkOut), 'HH:mm') : '—',
        duration(r.checkIn, r.checkOut),
        r.status,
      ]),
      headStyles: { fillColor: [27, 58, 107], textColor: 255, fontStyle: 'bold', fontSize: 8 },
      bodyStyles: { fontSize: 8 },
      alternateRowStyles: { fillColor: [245, 245, 250] },
      columnStyles: { 0: { cellWidth: 25 }, 3: { cellWidth: 18 }, 4: { cellWidth: 18 }, 5: { cellWidth: 22 }, 6: { cellWidth: 22 } },
    });

    doc.save(`reporte-${format(new Date(), 'yyyy-MM-dd')}.pdf`);
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Reportes"
        description="Análisis detallado de asistencias y registros."
        action={(
        <div className="flex gap-2 w-full sm:w-auto">
          <Button onClick={exportCSV} variant="outline" className="flex-1 sm:flex-none bg-white/10 border-white/20 text-white hover:bg-white/20">
            <Download className="w-4 h-4 mr-2" />CSV
          </Button>
          <Button onClick={exportPDF} variant="outline" className="flex-1 sm:flex-none bg-white/10 border-white/20 text-white hover:bg-white/20">
            <FileText className="w-4 h-4 mr-2" />PDF
          </Button>
        </div>
        )}
      />

      {/* Filtros */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Filter className="w-4 h-4" />Filtros
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="fs" className="text-xs uppercase tracking-wide text-gray-600">Estudiante</Label>
              <Select value={filterStudent} onValueChange={setFilterStudent}>
                <SelectTrigger id="fs"><SelectValue placeholder="Todos" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos</SelectItem>
                  {students.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="fp" className="text-xs uppercase tracking-wide text-gray-600">Práctica</Label>
              <Select value={filterPractice} onValueChange={setFilterPractice}>
                <SelectTrigger id="fp"><SelectValue placeholder="Todas" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todas</SelectItem>
                  {practices.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="fst" className="text-xs uppercase tracking-wide text-gray-600">Estado</Label>
              <Select value={filterStatus} onValueChange={setFilterStatus}>
                <SelectTrigger id="fst"><SelectValue placeholder="Todos" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos</SelectItem>
                  <SelectItem value="present">Presente</SelectItem>
                  <SelectItem value="late">Tardanza</SelectItem>
                  <SelectItem value="absent">Ausente</SelectItem>
                  <SelectItem value="excused">Justificado</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Resumen */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {[
          { label: 'Total Registros', value: filtered.length, cls: 'text-gray-900' },
          { label: 'Presentes', value: filtered.filter((r) => r.status === 'present').length, cls: 'text-green-600' },
          { label: 'Tardanzas', value: filtered.filter((r) => r.status === 'late').length, cls: 'text-yellow-600' },
          { label: 'Ausentes', value: filtered.filter((r) => r.status === 'absent').length, cls: 'text-red-600' },
        ].map(({ label, value, cls }) => (
          <Card key={label}>
            <CardContent className="pt-5 pb-4 text-center">
              <p className={`text-2xl sm:text-3xl font-semibold ${cls}`}>{value}</p>
              <p className="text-xs text-gray-600 mt-1">{label}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Tabla de registros */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle>Registros de Asistencia</CardTitle>
          <CardDescription>{filtered.length} registros encontrados</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {/* Desktop: tabla */}
          <div className="hidden lg:block overflow-x-auto">
            <Table className="min-w-[750px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Fecha</TableHead>
                  <TableHead>Estudiante</TableHead>
                  <TableHead>Práctica</TableHead>
                  <TableHead>Entrada</TableHead>
                  <TableHead>Salida</TableHead>
                  <TableHead>Duración</TableHead>
                  <TableHead>Estado</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center py-8 text-gray-500">No se encontraron registros</TableCell>
                  </TableRow>
                ) : (
                  filtered.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="whitespace-nowrap">{format(new Date(r.date), 'dd/MM/yyyy')}</TableCell>
                      <TableCell className="font-medium max-w-[160px] truncate">{r.studentName}</TableCell>
                      <TableCell className="max-w-[180px] truncate text-sm text-gray-700">{r.practiceName}</TableCell>
                      <TableCell className="font-mono text-xs">{format(new Date(r.checkIn), 'HH:mm')}</TableCell>
                      <TableCell className="font-mono text-xs">{r.checkOut ? format(new Date(r.checkOut), 'HH:mm') : '—'}</TableCell>
                      <TableCell>{duration(r.checkIn, r.checkOut)}</TableCell>
                      <TableCell>{statusBadge(r.status)}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>

          {/* Mobile/tablet: tarjetas */}
          <div className="lg:hidden divide-y divide-gray-100">
            {filtered.length === 0 ? (
              <p className="text-center py-8 text-gray-500">No se encontraron registros</p>
            ) : (
              filtered.map((r) => (
                <div key={r.id} className="p-4 space-y-2">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-gray-900 truncate">{r.studentName}</p>
                      <p className="text-xs text-gray-500 truncate mt-0.5">{r.practiceName}</p>
                    </div>
                    {statusBadge(r.status)}
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-1.5 text-xs text-gray-600">
                    <div><span className="text-gray-400">Fecha </span>{format(new Date(r.date), 'dd/MM/yyyy')}</div>
                    <div><span className="text-gray-400">Duración </span>{duration(r.checkIn, r.checkOut)}</div>
                    <div><span className="text-gray-400">Entrada </span>{format(new Date(r.checkIn), 'HH:mm')}</div>
                    <div><span className="text-gray-400">Salida </span>{r.checkOut ? format(new Date(r.checkOut), 'HH:mm') : '—'}</div>
                  </div>
                </div>
              ))
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
