import { AnalyticsError, DAY_MS, type VercelCredentials } from "./providers"
import { z } from "zod"

/** No endpoint override: fixtures cannot redirect credentials or run in deployed apps. */
export function analyticsFixtureEnabled(): boolean {
  if (process.env.NODE_ENV !== "development" || process.env.VERCEL_ENV || process.env.E2E_ISOLATED_DATABASE !== "1") return false
  try {
    const database = new URL(process.env.DATABASE_URL ?? "")
    return ["localhost", "127.0.0.1", "[::1]"].includes(database.hostname) && database.pathname === "/compass_e2e"
  } catch { return false }
}
export const analyticsFetch: typeof fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  if (analyticsFixtureEnabled() && url.origin === "https://api.vercel.com" && (url.searchParams.get("projectId") === "prj_compass_e2e" || url.pathname === "/v9/projects/prj_compass_e2e")) {
    if (url.pathname.startsWith("/v9/projects/")) return Response.json({ id: "prj_compass_e2e", webAnalytics: { id: "wa_fixture", enabledAt: 1, disabledAt: null, canceledAt: null, hasData: true } })
    if (url.searchParams.get("filter")?.includes("fixture_rate_limited")) return new Response(null, { status: 429 })
    const since = Date.parse(url.searchParams.get("since") ?? "")
    const until = Date.parse(url.searchParams.get("until") ?? "")
    if (!Number.isFinite(since) || !Number.isFinite(until) || until - since > 90 * DAY_MS) return new Response(null, { status: 400 })
    const data = []
    for (let date = since; date <= until; date += DAY_MS) data.push({ timestamp: new Date(date).toISOString(), pageviews: 12, visitors: 7, count: 4 })
    return Response.json({ data })
  }
  return fetch(input, init)
}
export async function validateVercelProject(connection: VercelCredentials, fetcher: typeof fetch = analyticsFetch): Promise<void> {
  const url = new URL(`https://api.vercel.com/v9/projects/${encodeURIComponent(connection.projectId)}`)
  if (connection.teamId) url.searchParams.set("teamId", connection.teamId)
  let response: Response
  try { response = await fetcher(url, { headers: { Authorization: `Bearer ${connection.token}` }, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15_000) }) }
  catch { throw new AnalyticsError("PROVIDER_UNAVAILABLE") }
  if (!response.ok) throw new AnalyticsError(response.status === 401 ? "AUTHENTICATION" : response.status === 429 ? "RATE_LIMITED" : "ACCESS_DENIED")
  let json: unknown
  try { json = await response.json() } catch { throw new AnalyticsError("INVALID_RESPONSE") }
  // Vercel SDK's types.optional() normalizes null to undefined as well.
  // https://github.com/vercel/sdk/blob/main/src/types/primitives.ts
  const timestamp = z.number().nullish()
  const parsed = z.object({ id: z.string(), webAnalytics: z.object({ enabledAt: timestamp, disabledAt: timestamp, canceledAt: timestamp }).nullish() }).safeParse(json)
  if (!parsed.success || parsed.data.id !== connection.projectId) throw new AnalyticsError("INVALID_RESPONSE")
  const analytics = parsed.data.webAnalytics
  if (!analytics || typeof analytics.enabledAt !== "number" || analytics.enabledAt <= 0 || (analytics.disabledAt ?? 0) >= analytics.enabledAt || (analytics.canceledAt ?? 0) >= analytics.enabledAt) throw new AnalyticsError("ANALYTICS_DISABLED")
}
