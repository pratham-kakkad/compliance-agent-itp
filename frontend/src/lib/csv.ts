/** Client-side CSV export of whatever a list currently shows (already filtered and sorted). */

export interface CsvColumn<T> {
  header: string;
  value: (row: T) => string | number | boolean | null | undefined;
}

function cell(v: string | number | boolean | null | undefined): string {
  if (v == null) return "";
  let s = String(v);
  // A spreadsheet would run a cell that starts with these as a formula; keep it as text.
  if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv<T>(columns: CsvColumn<T>[], rows: T[]): string {
  const lines = [columns.map((c) => cell(c.header)).join(",")];
  for (const r of rows) lines.push(columns.map((c) => cell(c.value(r))).join(","));
  return lines.join("\r\n");
}

/** Save `rows` as `<name>-<date>.csv` (UTF-8 with a BOM so Excel reads accents correctly). */
export function downloadCsv<T>(name: string, columns: CsvColumn<T>[], rows: T[]): void {
  const blob = new Blob(["﻿", toCsv(columns, rows)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${name}-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
