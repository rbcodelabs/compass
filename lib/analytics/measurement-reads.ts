import type { BindingDTO, MetricDTO, MetricTarget, ObservationDTO } from "@/lib/analytics/service"

// Client-side reads for the measurements panel. These use plain GET requests
// instead of server actions so a slow read can never roll the router back to
// the URL it started from (which reopened a just-closed detail panel).

async function getJson<T>(path: string, query: Record<string, string>): Promise<T> {
  const response = await fetch(`${path}?${new URLSearchParams(query)}`, { cache: "no-store", credentials: "same-origin" })
  if (!response.ok) throw new Error(`${path} failed with ${response.status}`)
  return response.json() as Promise<T>
}

export function readMeasurements(orgSlug: string, workspaceSlug: string, target: MetricTarget) {
  return getJson<{ binding: BindingDTO; observations: ObservationDTO[] }[]>("/api/analytics/measurements", { orgSlug, workspaceSlug, ...target })
}

export function listAnalyticsMetrics(orgSlug: string, workspaceSlug: string) {
  return getJson<MetricDTO[]>("/api/analytics/metrics", { orgSlug, workspaceSlug })
}
