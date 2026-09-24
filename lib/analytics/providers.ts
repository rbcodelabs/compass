import { z } from "zod"

export const DAY_MS = 86_400_000
export const windowSchema = z.object({ since: z.string(), until: z.string() }).strict()
export type MetricWindow = z.infer<typeof windowSchema>
export const querySchema = z.object({
  metric: z.enum(["pageviews", "daily_visitors", "event_count", "active_discovery_teams"]),
  eventName: z.string().min(1).max(255).optional(),
  path: z.string().startsWith("/").max(500).optional(),
  eventProperties: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/), z.string().max(255)).optional(),
  flags: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/), z.string().max(255)).optional(),
}).strict()
export type MetricQuery = z.infer<typeof querySchema>
export type ProviderId = "vercel" | "compass_activation"
export type ObservationData = { value: number | null; series: { date: string; value: number }[]; completeness: "COMPLETE" | "PARTIAL" | "UNAVAILABLE"; note: string | null; provenance: Record<string, unknown> }
export type VercelCredentials = { projectId: string; teamId?: string | null; token: string }
export class AnalyticsError extends Error {
  constructor(public code: string) { super(code); this.name = "AnalyticsError" }
}
export function validateWindow(input: MetricWindow) {
  const window = windowSchema.parse(input)
  for (const date of [window.since, window.until]) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) throw new AnalyticsError("INVALID_WINDOW")
  }
  const days = (Date.parse(window.until) - Date.parse(window.since)) / DAY_MS + 1
  if (days < 1 || days > 90) throw new AnalyticsError("INVALID_WINDOW")
  return { ...window, days }
}
export function validateQuery(provider: ProviderId, input: unknown): MetricQuery {
  const query = querySchema.parse(input)
  if (provider === "compass_activation") {
    if (query.metric !== "active_discovery_teams" || Object.keys(query).length !== 1) throw new AnalyticsError("UNSUPPORTED_QUERY")
  } else if (provider === "vercel") {
    if (query.metric === "active_discovery_teams" || (query.metric === "event_count" && !query.eventName) || (query.metric !== "event_count" && (query.eventName || query.eventProperties))) throw new AnalyticsError("UNSUPPORTED_QUERY")
  } else throw new AnalyticsError("UNSUPPORTED_PROVIDER")
  if (Object.keys(query.eventProperties ?? {}).length + Object.keys(query.flags ?? {}).length > 8) throw new AnalyticsError("TOO_MANY_FILTERS")
  return query
}
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`
export function buildVercelUrl(connection: VercelCredentials, input: MetricQuery, inputWindow: MetricWindow) {
  const query = validateQuery("vercel", input)
  const window = validateWindow(inputWindow)
  const dataset = query.metric === "event_count" ? "events" : "visits"
  const url = new URL(`https://api.vercel.com/v1/query/web-analytics/${dataset}/aggregate`)
  const filters: string[] = []
  if (query.eventName) filters.push(`eventName eq ${quote(query.eventName)}`)
  if (query.path) filters.push(`requestPath eq ${quote(query.path)}`)
  for (const [key, value] of Object.entries(query.eventProperties ?? {}).sort()) filters.push(`eventData/${key} eq ${quote(value)}`)
  for (const [key, value] of Object.entries(query.flags ?? {}).sort()) filters.push(`flags/${key} eq ${quote(value)}`)
  url.searchParams.set("projectId", connection.projectId)
  if (connection.teamId) url.searchParams.set("teamId", connection.teamId)
  url.searchParams.set("since", window.since)
  url.searchParams.set("until", window.until)
  url.searchParams.set("by", "day")
  url.searchParams.set("limit", "100")
  url.searchParams.set("environment", "production")
  if (filters.length) url.searchParams.set("filter", filters.join(" and "))
  return url
}
export async function fetchVercelObservation(connection: VercelCredentials, query: MetricQuery, window: MetricWindow, fetcher: typeof fetch = fetch): Promise<ObservationData> {
  const url = buildVercelUrl(connection, query, window)
  let response: Response
  try { response = await fetcher(url, { headers: { Authorization: `Bearer ${connection.token}` }, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15_000) }) }
  catch { throw new AnalyticsError("PROVIDER_UNAVAILABLE") }
  if (!response.ok) throw new AnalyticsError(({ 401: "AUTHENTICATION", 402: "PLAN_REQUIRED", 403: "ACCESS_DENIED", 404: "PROJECT_NOT_FOUND", 410: "DATA_UNAVAILABLE", 429: "RATE_LIMITED" } as Record<number, string>)[response.status] ?? "PROVIDER_UNAVAILABLE")
  let body: unknown
  try { body = await response.json() } catch { throw new AnalyticsError("INVALID_RESPONSE") }
  const parsed = z.object({ data: z.array(z.record(z.string(), z.unknown())).max(100) }).safeParse(body)
  if (!parsed.success) throw new AnalyticsError("INVALID_RESPONSE")
  const field = query.metric === "pageviews" ? "pageviews" : query.metric === "daily_visitors" ? "visitors" : "count"
  const series: ObservationData["series"] = []
  const seen = new Set<string>()
  for (const row of parsed.data.data) {
    const timestamp = row.timestamp
    const value = row[field]
    if (typeof timestamp !== "string" || !/^\d{4}-\d{2}-\d{2}T00:00:00(?:\.000)?Z$/.test(timestamp) || typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new AnalyticsError("INVALID_RESPONSE")
    const date = timestamp.slice(0, 10)
    if (date < window.since || date > window.until || seen.has(date)) throw new AnalyticsError("INVALID_RESPONSE")
    seen.add(date); series.push({ date, value })
  }
  series.sort((a, b) => a.date.localeCompare(b.date))
  const openWindow = window.until >= new Date().toISOString().slice(0, 10)
  const missing = series.length !== validateWindow(window).days
  const unavailable = series.length === 0
  const total = query.metric === "daily_visitors" ? null : series.reduce((sum, point) => sum + point.value, 0)
  if (total !== null && !Number.isSafeInteger(total)) throw new AnalyticsError("INVALID_RESPONSE")
  const note = unavailable ? "No daily buckets returned; collection or retention coverage cannot be confirmed." : missing ? "Some daily buckets are missing; no zero values have been inferred." : openWindow ? "The window includes an unfinished or future UTC day." : query.metric === "daily_visitors" ? "Daily visitors cannot be summed into unique visitors for the period." : null
  return { value: missing || openWindow ? null : total, series, completeness: unavailable ? "UNAVAILABLE" : openWindow || missing ? "PARTIAL" : "COMPLETE", note, provenance: { provider: "vercel", projectId: connection.projectId, teamId: connection.teamId ?? null, environment: "production", timezone: "UTC", endpoint: url.pathname } }
}
