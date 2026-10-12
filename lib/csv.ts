/**
 * Minimal CSV serialisation for the export endpoints (Discovery, card sort).
 *
 * Pure and dependency-free so both routes and their unit tests share one
 * implementation of the two things that go wrong in hand-rolled CSV:
 *
 *   1. Quoting. A cell containing a comma, quote, CR or LF is wrapped in double
 *      quotes with embedded quotes doubled (RFC 4180). Titles and rationales are
 *      free text, so this is the normal case rather than an edge.
 *   2. Formula injection. Titles, rationales and display names are authored by
 *      other users, and the point of a CSV is that somebody opens it in Excel or
 *      Sheets. A string beginning with = + - @ (or a tab / CR) is executed as a
 *      formula there, so it is prefixed with an apostrophe, the standard OWASP
 *      mitigation. Numbers are exempt: a real -3 must stay a number.
 */

export type CsvCell = string | number | boolean | null | undefined

const FORMULA_TRIGGER = /^[=+\-@\t\r]/

export function csvCell(value: CsvCell): string {
  if (value === null || value === undefined) return ""
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : ""
  if (typeof value === "boolean") return value ? "true" : "false"

  const text = FORMULA_TRIGGER.test(value) ? `'${value}` : value
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** UTF-8 byte order mark: without it Excel opens non-ASCII text as Windows-1252. */
const UTF8_BOM = "\uFEFF"

/** Serialises a header row plus data rows. CRLF line endings per RFC 4180. */
export function toCsv(header: readonly string[], rows: readonly (readonly CsvCell[])[]): string {
  const lines = [header, ...rows].map((row) => row.map(csvCell).join(","))
  return `${UTF8_BOM}${lines.join("\r\n")}\r\n`
}

/** A filesystem- and header-safe filename stem: "Q3 priorities / v2" → "q3-priorities-v2". */
export function csvFilenameStem(name: string, fallback: string): string {
  const stem = name
    .normalize("NFKD")
    .replace(/[^\x20-\x7e]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
  return stem || fallback
}

/** A Response carrying `csv` as a download. `private, no-store`: these are tenant data. */
export function csvDownloadResponse(csv: string, filename: string): Response {
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "private, no-store",
    },
  })
}
