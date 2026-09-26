import type { MetricQuery, ObservationData } from "./providers"

/**
 * Freshness/staleness for the Metrics dashboard widget grid.
 *
 * This intentionally does not invent a new "freshness" concept: it reads the
 * same signals lib/analytics/service.ts already tracks per binding/connection
 * (MetricBinding.lastError/lastAttemptAt, AnalyticsConnection.health, and
 * MetricObservation.retrievedAt) rather than a bespoke status field. A failed
 * or stale refresh always surfaces as "failed"/"stale" here -- it never
 * silently reports as if it were zero (see measurementsPanel and the archive
 * dialog copy for the same rule elsewhere in the product).
 */

/** Vercel Web Analytics ingests same-day data with up to ~24h lag; 2x that
 * (48h) since the last successful observation is the point a widget stops
 * reading as "fresh" and starts reading as "stale". */
export const STALE_AFTER_MS = 48 * 60 * 60 * 1000

export type CardStatus = "fresh" | "stale" | "failed"

const ERROR_LABEL: Record<string, string> = {
  AUTHENTICATION: "provider token rejected",
  ACCESS_DENIED: "provider access denied",
  PROJECT_NOT_FOUND: "provider project not found",
  ANALYTICS_DISABLED: "Web Analytics disabled for this project",
  PLAN_REQUIRED: "plan upgrade required",
  RATE_LIMITED: "provider rate-limited",
  PROVIDER_UNAVAILABLE: "provider unavailable",
  DATA_UNAVAILABLE: "no data for this window",
  DISCONNECTED: "provider disconnected",
  CONNECTION_CHANGED: "provider connection changed",
}

export function humanizeErrorCode(code: string): string {
  return ERROR_LABEL[code] ?? "sync failed"
}

export function formatRelative(ms: number): string {
  if (ms < 0) ms = 0
  if (ms < 60_000) return "just now"
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`
  return `${Math.round(ms / 86_400_000)}d ago`
}

export function headlineValue(query: Pick<MetricQuery, "metric">, data: ObservationData): number | null {
  // daily_visitors can't be summed into a unique total for the window (see
  // providers.ts) -- the most recent day's count is the closest thing to a
  // single "current" headline value.
  if (query.metric === "daily_visitors") return data.series.length ? data.series[data.series.length - 1].value : null
  return data.value
}

export type CardDelta = { direction: "up" | "down"; diff: number }

/** Change vs. a prior observation of the same kind. Never fabricated when either side is missing. */
export function computeDelta(current: number | null, previous: number | null): CardDelta | null {
  if (current == null || previous == null) return null
  const diff = current - previous
  return { direction: diff >= 0 ? "up" : "down", diff }
}

export function computeCardStatus(params: {
  hasActiveBinding: boolean
  /** null when not applicable (native metric, or no binding to check a connection for). */
  connectionHealthy: boolean | null
  lastError: string | null
  lastAttemptAt: Date | null
  latestObservationAt: Date | null
  now: Date
}): { status: CardStatus; caption: string } {
  const { hasActiveBinding, connectionHealthy, lastError, lastAttemptAt, latestObservationAt, now } = params

  if (lastError) {
    const when = lastAttemptAt ? ` ${formatRelative(now.getTime() - lastAttemptAt.getTime())}` : ""
    return { status: "failed", caption: `Sync failed${when} — ${humanizeErrorCode(lastError)}` }
  }
  // Connection health only matters once something is actually depending on
  // it -- a metric with zero bindings hasn't failed a refresh, it just
  // hasn't been used yet, so "not yet linked" is the more useful message.
  if (hasActiveBinding && connectionHealthy === false) {
    return { status: "failed", caption: "Provider disconnected" }
  }
  if (!latestObservationAt) {
    return { status: "fresh", caption: hasActiveBinding ? "No observations yet — refresh to collect the first snapshot" : "Not yet linked to a metric binding" }
  }
  const age = now.getTime() - latestObservationAt.getTime()
  if (age > STALE_AFTER_MS) {
    return { status: "stale", caption: `No new data for ${formatRelative(age)}` }
  }
  return { status: "fresh", caption: `Updated ${formatRelative(age)}` }
}
