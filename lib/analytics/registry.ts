import { AnalyticsError, DAY_MS, fetchVercelObservation, validateQuery, type MetricQuery, type MetricWindow, type ObservationData, type ProviderId, type VercelCredentials } from "./providers"
import { fetchActivationObservation } from "./activation"

export type ProviderContext = {
  query: MetricQuery
  window: MetricWindow
  credentials?: VercelCredentials
  fetcher?: typeof fetch
  activation?: { count: (cutoff: Date, now: Date) => Promise<number>; now?: Date; epoch?: string }
}
export function effectiveObservationWindow(provider: ProviderId, kind: "BASELINE" | "FOLLOWUP", logical: MetricWindow, now = new Date()): MetricWindow {
  if (ANALYTICS_PROVIDERS[provider].capabilities.windowMode !== "current_snapshot" || kind === "BASELINE") return logical
  return { since: new Date(now.getTime() - 29 * DAY_MS).toISOString().slice(0, 10), until: now.toISOString().slice(0, 10) }
}
export interface AnalyticsAdapter {
  id: ProviderId
  capabilities: { metrics: readonly MetricQuery["metric"][]; maxWindowDays: number; filters: readonly string[]; windowMode: "calendar" | "current_snapshot" }
  validate(query: unknown): MetricQuery
  fetch(context: ProviderContext): Promise<ObservationData>
}
/** Adapters are code-reviewed server modules, never uploaded executable code. */
export const ANALYTICS_PROVIDERS: Record<ProviderId, AnalyticsAdapter> = {
  vercel: {
    id: "vercel",
    capabilities: { metrics: ["pageviews", "daily_visitors", "event_count"], maxWindowDays: 90, filters: ["path", "eventProperties", "flags"], windowMode: "calendar" },
    validate: query => validateQuery("vercel", query),
    fetch: context => {
      if (!context.credentials) throw new AnalyticsError("DISCONNECTED")
      return fetchVercelObservation(context.credentials, validateQuery("vercel", context.query), context.window, context.fetcher)
    },
  },
  compass_activation: {
    id: "compass_activation",
    capabilities: { metrics: ["active_discovery_teams"], maxWindowDays: 30, filters: [], windowMode: "current_snapshot" },
    validate: query => validateQuery("compass_activation", query),
    fetch: context => {
      validateQuery("compass_activation", context.query)
      if (!context.activation) throw new AnalyticsError("ACTIVATION_NOT_CONFIGURED")
      return fetchActivationObservation(context.window, context.activation.count, context.activation.now, context.activation.epoch)
    },
  },
}
