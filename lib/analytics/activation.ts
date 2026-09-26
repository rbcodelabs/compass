import { DAY_MS, validateWindow, type MetricWindow, type ObservationData } from "./providers"

/** Last-action timestamps cannot reconstruct past states. Only now is queryable. */
export async function fetchActivationObservation(window: MetricWindow, count: (cutoff: Date, now: Date) => Promise<number>, now = new Date(), epoch = process.env.COMPASS_ANALYTICS_COLLECTION_STARTED_AT): Promise<ObservationData> {
  const range = validateWindow(window)
  const start = epoch ? new Date(epoch) : null
  const provenance = { provider: "compass_activation", population: "eligible production workspaces", asOf: now.toISOString(), coverageStart: new Date(now.getTime() - 30 * DAY_MS).toISOString(), coverageEnd: now.toISOString(), collectionStartedAt: start && Number.isFinite(start.getTime()) ? start.toISOString() : null, trailingDays: 30 }
  if (!start || !Number.isFinite(start.getTime()) || start > now) return { value: null, series: [], completeness: "UNAVAILABLE", note: "Prospective activation collection is not configured.", provenance }
  if (range.days !== 30 || range.until !== now.toISOString().slice(0, 10)) return { value: null, series: [], completeness: "UNAVAILABLE", note: "Historical activation is unavailable. This provider supports the current trailing 30 days; saved observations remain historical snapshots.", provenance }
  const cutoff = new Date(now.getTime() - 30 * DAY_MS)
  const value = await count(cutoff, now)
  const partial = start > cutoff
  return { value, series: [{ date: range.until, value }], completeness: partial ? "PARTIAL" : "COMPLETE", note: partial ? "Collection has not yet covered a full 30 days." : null, provenance }
}
