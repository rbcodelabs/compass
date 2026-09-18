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

/**
 * Every type that has a canonical in-app location. `doc` is not an
 * `EntityType` (docs have no detail panel) but does have its own page, and the
 * search results and `create_doc` both need to link to it.
 */
export type EntityLinkType = EntityType | "doc"

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
  const id = encodeURIComponent(input.id)
  const panel = panelQuery(input.type, input.id)
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
