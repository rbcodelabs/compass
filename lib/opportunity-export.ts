import { toCsv } from "@/lib/csv"

/**
 * Row shape for the Discovery CSV export. Pure, so the column contract is unit
 * tested without a database; the route owns the query and the filters.
 */
export type OpportunityExportRow = {
  id: string
  title: string
  status: string
  customerSegment: string | null
  squadName: string | null
  /** 0–100 normalised score; null when there is no score or no active scoring model. */
  score: number | null
  solutionCount: number
  evidenceCount: number
}

export const OPPORTUNITY_EXPORT_HEADER = [
  "Title",
  "Status",
  "Squad",
  "Customer segment",
  "Score",
  "Solutions",
  "Evidence",
  "Link",
] as const

/**
 * @param origin  e.g. "https://compass.example.com" — used to build absolute
 *                links, since a CSV is opened far from the page it came from.
 */
export function buildOpportunityCsv(
  rows: readonly OpportunityExportRow[],
  args: { origin: string; orgSlug: string; workspaceSlug: string }
): string {
  const base = `${args.origin}/${args.orgSlug}/${args.workspaceSlug}/discovery`
  return toCsv(
    OPPORTUNITY_EXPORT_HEADER,
    rows.map((row) => [
      row.title,
      row.status,
      row.squadName,
      row.customerSegment,
      row.score,
      row.solutionCount,
      row.evidenceCount,
      `${base}/${row.id}`,
    ])
  )
}
