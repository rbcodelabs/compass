/**
 * The single source of truth for "where does this entity live?" — the relative
 * path that addresses one Compass entity inside a workspace.
 *
 * Two very different consumers need the same answer and used to derive it
 * separately:
 *   - the in-app workspace search (lib/workspace-search.ts), which renders
 *     `href`s a human clicks, and
 *   - the MCP tools, which hand an agent a link to relay to a human
 *     (lib/compass-url.ts composes these paths onto the trusted origin).
 * Keeping the mapping here means a route rename can't leave one of them
 * pointing at a 404 while the other still works.
 *
 * ## Two addressing shapes
 * Some entities have a page of their own (`/discovery/{id}`, `/tasks/{id}`).
 * The rest are shown in the workspace-global detail panel, addressed by the
 * `?detail=<type>:<id>` search param that components/panels/panel-context.tsx
 * reads. `PanelProvider` mounts in the workspace layout, so `?detail=` resolves
 * on *any* page under `/{orgSlug}/{workspaceSlug}` — the page a panel link
 * lands on is chosen for context (a solution opens on its opportunity), and
 * the workspace root is always a valid fallback when that context is unknown.
 *
 * Deliberately dependency-free: no Prisma, no `lib/compass-url.ts`, no
 * `next/*`. This module has to stay importable from client components, and it
 * must not be able to throw — an unresolvable *origin* is compass-url.ts's
 * problem, not this module's.
 */

// Type-only import: erased at compile time, so entity-detail.ts's Prisma
// dependency never reaches a client bundle. The `satisfies` check below makes
// the compiler prove this module still covers every panel entity type.
import type { EntityType } from "@/lib/entity-detail"
import { classifyWorkItemRef } from "@/lib/work-item-ids"

/**
 * Every type that has a canonical in-app location. `doc` and `artifact` are
 * not `EntityType`s (neither has a detail panel) but each has its own page, and
 * the search results and the `create_doc` / artifact MCP tools link to them.
 */
export type EntityLinkType = EntityType | "doc" | "artifact"

// Compile-time proof that EntityLinkType covers every panel entity type, so
// adding a type to lib/entity-detail.ts's ENTITY_TYPES fails the build here
// until this module knows where to point it.
const _COVERS_EVERY_ENTITY_TYPE = {
  objective: true,
  keyResult: true,
  opportunity: true,
  solution: true,
  assumption: true,
  experiment: true,
  roadmapItem: true,
  feedback: true,
  task: true,
  doc: true,
  artifact: true,
} satisfies Record<EntityLinkType, true>
void _COVERS_EVERY_ENTITY_TYPE

export type WorkspaceSlugs = {
  orgSlug: string
  workspaceSlug: string
}

export type EntityLinkInput = WorkspaceSlugs & {
  type: EntityLinkType
  id: string
  /**
   * `TASK-5`, when the caller has it. Links carry the display ID instead of the UUID so people and agents share
   * readable URLs; the UUID still resolves (and is redirected to this form) on every route that accepts either.
   * Rows that are not numbered yet pass nothing and keep a UUID link.
   */
  displayId?: string | null
  /**
   * The owning Opportunity, for the two types whose panel is shown in the
   * context of a discovery page (`solution`, `assumption`). Optional
   * everywhere: without it those links fall back to the workspace root, which
   * still opens the right panel.
   */
  opportunityId?: string | null
}

/** `/{orgSlug}/{workspaceSlug}` — the root every workspace path hangs off. */
export function workspaceBasePath({ orgSlug, workspaceSlug }: WorkspaceSlugs): string {
  return `/${encodeURIComponent(orgSlug)}/${encodeURIComponent(workspaceSlug)}`
}

/** The `?detail=` value the panel router decodes back into (type, id). */
function panelQuery(type: EntityLinkType, id: string): string {
  return `?detail=${encodeURIComponent(`${type}:${id}`)}`
}

/**
 * The canonical relative path for one entity. Never throws and never returns
 * an absolute URL — see `entityUrl` in lib/compass-url.ts for the absolute
 * form.
 */
export function entityPath(input: EntityLinkInput): string {
  const base = workspaceBasePath(input)
  const ref = input.displayId || input.id
  const id = encodeURIComponent(ref)
  const panel = panelQuery(input.type, ref)
  // The discovery page of the owning opportunity, when we know it. Both
  // callers below degrade to the workspace root, where the panel still opens.
  const discoveryContext = input.opportunityId
    ? `${base}/discovery/${encodeURIComponent(input.opportunityId)}`
    : base

  switch (input.type) {
    // ── Entities with a page of their own ──────────────────────────────────
    case "opportunity":
      return `${base}/discovery/${id}`
    case "experiment":
      return `${base}/experiments/${id}`
    case "task":
      return `${base}/tasks/${id}`
    case "doc":
      return `${base}/docs/${id}`
    case "artifact":
      return `${base}/docs/artifacts/${id}`

    // ── Entities addressed by the ?detail= panel ───────────────────────────
    case "solution":
    case "assumption":
      return `${discoveryContext}${panel}`
    case "roadmapItem":
      return `${base}/roadmap${panel}`
    case "feedback":
      return `${base}/feedback${panel}`
    case "objective":
    case "keyResult":
      return `${base}/okrs${panel}`
  }
}

// ── Parsing: the inverse of entityPath ──────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Ids are UUIDs; checking shape here keeps page names (`discovery/tree`) from parsing as entities and keeps non-UUID input away from the uuid columns. */
export function isEntityId(value: string): boolean {
  return UUID_RE.test(value)
}

/**
 * A UUID or a display ID (`TASK-5`). What a link may carry; the server resolves either inside the workspace.
 * Page names such as `tree` or `card-sort` are neither, so they still do not parse as entities.
 */
export function isEntityRef(value: string): boolean {
  return classifyWorkItemRef(value).kind !== "invalid"
}

const PANEL_LINK_TYPES: ReadonlySet<string> = new Set<EntityLinkType>([
  "objective",
  "keyResult",
  "opportunity",
  "solution",
  "assumption",
  "experiment",
  "roadmapItem",
  "feedback",
  "task",
])

/** `id` is the link's reference as written: a UUID or a display ID. Resolve it server-side before using it as a key. */
export type ParsedEntityLink = WorkspaceSlugs & { type: EntityLinkType; id: string }

function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment)
  } catch {
    return null
  }
}

/**
 * Recognises a link that `entityPath` could have produced and returns what it
 * addresses, or null for anything else (other pages, other hosts, malformed
 * ids). Pure and never throws, so it is safe in a markdown renderer.
 *
 * `href` may be a relative path or an absolute URL. An absolute URL only
 * counts when its origin equals `currentOrigin` — a link to some other host is
 * never promoted to a card, however Compass-shaped its path is.
 *
 * Deliberately a recogniser, not an authority: it says what the link *claims*
 * to point at. Whether the reader may see it is decided by the server when the
 * card asks for its summary.
 */
export function parseEntityLink(href: string, currentOrigin?: string | null): ParsedEntityLink | null {
  let url: URL
  try {
    const isAbsolute = /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(href)
    if (isAbsolute) {
      url = new URL(href)
      if (!currentOrigin || url.origin !== currentOrigin) return null
    } else if (href.startsWith("/") && !href.startsWith("//")) {
      url = new URL(href, "http://compass.invalid")
    } else {
      return null
    }
  } catch {
    return null
  }

  const segments = url.pathname.split("/").filter(Boolean).map(decodeSegment)
  if (segments.some((s) => s === null)) return null
  const [orgSlug, workspaceSlug, section, first, second, ...extra] = segments as string[]
  if (!orgSlug || !workspaceSlug) return null
  const slugs = { orgSlug, workspaceSlug }

  // A page of its own: /{org}/{ws}/{section}/{id}
  const own = (type: EntityLinkType, id: string | undefined): ParsedEntityLink | null =>
    id && isEntityRef(id) && extra.length === 0 ? { ...slugs, type, id } : null

  // A ?detail=<type>:<id> panel link is valid on any workspace page and names the
  // entity actually shown, so it wins over the page it sits on (a solution link
  // rides on its opportunity's discovery page).
  const detail = url.searchParams.get("detail")
  const sep = detail ? detail.indexOf(":") : -1
  if (detail && sep > 0) {
    const type = detail.slice(0, sep)
    const id = detail.slice(sep + 1)
    if (PANEL_LINK_TYPES.has(type) && isEntityRef(id)) return { ...slugs, type: type as EntityLinkType, id }
  }

  if (section === "docs" && first === "artifacts") return own("artifact", second)
  if (second) return null
  switch (section) {
    case "discovery": return own("opportunity", first)
    case "experiments": return own("experiment", first)
    case "tasks": return own("task", first)
    case "docs": return own("doc", first)
    case "roadmap": return own("roadmapItem", first)
    default: return null
  }
}
