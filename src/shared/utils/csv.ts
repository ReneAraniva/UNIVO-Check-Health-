// Exportación CSV única para toda la app (auditoría de código limpio P0-2).
// Antes había tres exportadores y dos no escapaban: un nombre como
// "Pérez Gómez, Ana" corría todas las columnas siguientes una posición.

// Texto que Excel/Sheets interpretaría como fórmula (inyección CSV). Los números
// negativos legítimos ("-3.5") no se tocan.
const FORMULA_PREFIX = /^[=+\-@\t\r]/;
const NUMERIC = /^-?\d+(\.\d+)?$/;

// Escapa un campo para CSV (comillas, comas, saltos de línea) y neutraliza fórmulas.
export function csvCell(value: unknown): string {
  let s = value == null ? '' : String(value);
  if (typeof value === 'string' && FORMULA_PREFIX.test(s) && !NUMERIC.test(s)) {
    s = `'${s}`;
  }
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header: string[], rows: unknown[][]): string {
  return [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\n');
}

// BOM UTF-8: sin él Excel abre los acentos rotos.
export function downloadCsv(csv: string, filename: string): void {
  downloadFile(`﻿${csv}`, 'text/csv', filename);
}

export function downloadFile(content: string, mime: string, filename: string): void {
  const blob = new Blob([content], { type: `${mime};charset=utf-8;` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
