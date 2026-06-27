/**
 * Minimal CSV builder + browser download — the write-side counterpart to the
 * parser in `csv.ts`. No external deps: every field is quoted and embedded
 * quotes are doubled, so commas / newlines / quotes in values are safe.
 */
export function toCsv(headers: string[], rows: Array<Record<string, unknown>>): string {
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return `"${s.replace(/"/g, '""')}"`;
  };
  const lines = [headers.map(esc).join(",")];
  for (const row of rows) lines.push(headers.map((h) => esc(row[h])).join(","));
  return lines.join("\r\n");
}

/** Build a CSV and trigger a browser download. BOM-prefixed (U+FEFF) so Excel reads UTF-8. */
export function downloadCsv(filename: string, headers: string[], rows: Array<Record<string, unknown>>): void {
  const csv = toCsv(headers, rows);
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
