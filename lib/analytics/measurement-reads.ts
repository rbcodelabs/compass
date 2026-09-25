import type { BindingDTO, MetricDTO, MetricTarget, ObservationDTO } from "@/lib/analytics/service"

// Client-side reads for the measurements panel. These use plain GET requests
// instead of server actions so a slow read can never roll the router back to
// the URL it started from (which reopened a just-closed detail panel).

// NOTE: JSON transport delivers Date fields (createdAt, updatedAt, retrievedAt,
// lastAttemptAt) as ISO strings even though the DTO types say Date. Panel state
// also receives real Dates from refresh server actions, so never call Date
// methods or compare these fields directly; always wrap them in new Date(...).
export type MeasurementRead = { binding: BindingDTO; observations: ObservationDTO[] }

async function getJson<T>(path: string, query: Record<string, string>): Promise<T> {
  const response = await fetch(`${path}?${new URLSearchParams(query)}`, { cache: "no-store", credentials: "same-origin" })
  // An expired session is redirected to the login page (HTML 200) by proxy.ts.
  if (response.redirected || !(response.headers.get("content-type") ?? "").includes("application/json")) {
    throw new Error(`${path} did not return JSON (session may have expired)`)
  }
  if (!response.ok) throw new Error(`${path} failed with ${response.status}`)
  return response.json() as Promise<T>
}

export function readMeasurements(orgSlug: string, workspaceSlug: string, target: MetricTarget) {
  return getJson<MeasurementRead[]>("/api/analytics/measurements", { orgSlug, workspaceSlug, ...target })
}

export function listAnalyticsMetrics(orgSlug: string, workspaceSlug: string) {
  return getJson<MetricDTO[]>("/api/analytics/metrics", { orgSlug, workspaceSlug })
}
