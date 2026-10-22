/**
 * Gate for the chain graph (v1 is panel-only and not in the sidebar; the route is a spike until Phase 3 wires entry points).
 * Same posture as the /ui registry: on in development and preview, opt-in elsewhere with COMPASS_CHAIN_GRAPH=1. Exact match, no trimming.
 */
export function chainGraphEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.NODE_ENV === "development" || env.VERCEL_ENV === "preview" || env.COMPASS_CHAIN_GRAPH === "1"
}

/** The synthetic-data benchmark page: development or an explicit flag only, never implied by preview. */
export function chainGraphBenchEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.NODE_ENV === "development" || env.COMPASS_CHAIN_GRAPH_BENCH === "1"
}

/** Parses `?focus=<TYPE>:<uuid>`; null for anything malformed or outside the v1 core chain. */
export function parseFocus(raw: string | string[] | undefined): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw
  if (!value) return null
  const match = /^(OBJECTIVE|OPPORTUNITY|SOLUTION|ASSUMPTION|EXPERIMENT|ROADMAP_ITEM):([A-Za-z0-9-]{1,64})$/.exec(value)
  return match ? `${match[1]}:${match[2]}` : null
}
