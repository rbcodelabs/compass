/**
 * Pure helpers shared by the /dashboard gallery and the sidebar picker.
 * No React, no browser APIs — everything here is unit-testable in isolation.
 */

export interface SelectorWorkspace {
  id: string
  name: string
  slug: string
  orgSlug: string
  orgName: string
  description?: string | null
  memberCount?: number
  isReadOnly?: boolean
}

export type CoverMotif = "dots" | "stripes" | "contours"

const HUES = [262, 18, 190, 150, 225, 340, 32, 285] as const
const MOTIFS: readonly CoverMotif[] = ["dots", "stripes", "contours"]

/** Stable identity for a workspace across orgs (slugs are only unique per org). */
export function workspaceKey(ws: Pick<SelectorWorkspace, "orgSlug" | "slug">): string {
  return `${ws.orgSlug}/${ws.slug}`
}

export function workspaceHref(ws: Pick<SelectorWorkspace, "orgSlug" | "slug">): string {
  return `/${ws.orgSlug}/${ws.slug}/okrs`
}

/** Deterministic string hash so a workspace always gets the same cover. */
export function hashName(name: string): number {
  let h = 7
  for (let i = 0; i < name.length; i++) {
    h = (h * 31 + name.charCodeAt(i)) >>> 0
  }
  return h
}

export function hueFor(name: string): number {
  return HUES[hashName(name) % HUES.length]
}

export function motifFor(name: string): CoverMotif {
  return MOTIFS[(hashName(name) >>> 4) % MOTIFS.length]
}

export function initialFor(name: string): string {
  const trimmed = name.trim()
  return trimmed ? Array.from(trimmed)[0].toUpperCase() : "?"
}

/** Accessible name shared by tiles and rows. */
export function describeWorkspace(ws: SelectorWorkspace, isCurrent: boolean): string {
  const bits = [ws.name, ws.orgName]
  if (isCurrent) bits.push("current workspace")
  if (ws.isReadOnly) bits.push("read-only")
  return bits.join(", ")
}

/** Every whitespace-separated token must appear in name + description + org name. */
export function matchesQuery(ws: SelectorWorkspace, query: string): boolean {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return true
  const haystack = `${ws.name} ${ws.description ?? ""} ${ws.orgName}`.toLowerCase()
  return tokens.every((t) => haystack.includes(t))
}

export interface OrgGroup {
  orgSlug: string
  orgName: string
  items: SelectorWorkspace[]
}

/** Group by org, preserving first-seen order of orgs and of workspaces within. */
export function groupByOrg(list: readonly SelectorWorkspace[]): OrgGroup[] {
  const groups = new Map<string, OrgGroup>()
  for (const ws of list) {
    let g = groups.get(ws.orgSlug)
    if (!g) {
      g = { orgSlug: ws.orgSlug, orgName: ws.orgName, items: [] }
      groups.set(ws.orgSlug, g)
    }
    g.items.push(ws)
  }
  return [...groups.values()]
}

/** Visit log: workspaceKey -> epoch ms of the last visit. */
export type VisitLog = Record<string, number>

/** Most recently visited first; never-visited workspaces are excluded. */
export function recentWorkspaces(
  list: readonly SelectorWorkspace[],
  visits: VisitLog,
  limit = 3
): SelectorWorkspace[] {
  return list
    .filter((ws) => typeof visits[workspaceKey(ws)] === "number")
    .sort((a, b) => visits[workspaceKey(b)] - visits[workspaceKey(a)])
    .slice(0, limit)
}

const DAY_MS = 86_400_000

/** "Today", "Yesterday", "3 days ago", "Last week"… or "Never visited". */
export function visitedLabel(visitedAt: number | undefined, now: number = Date.now()): string {
  if (typeof visitedAt !== "number") return "Never visited"
  const days = Math.max(0, Math.floor((startOfDay(now) - startOfDay(visitedAt)) / DAY_MS))
  if (days === 0) return "Today"
  if (days === 1) return "Yesterday"
  if (days < 7) return `${days} days ago`
  if (days < 14) return "Last week"
  if (days < 30) return `${Math.floor(days / 7)} weeks ago`
  if (days < 60) return "Last month"
  return `${Math.floor(days / 30)} months ago`
}

function startOfDay(ms: number): number {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

export function pluralize(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`
}

export function greetingFor(hour: number): string {
  return hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening"
}
