// Where on the page a text selection came from: which entity, and which field of it.
//
// Surfaces opt in with data attributes (no behaviour, no visuals):
//
//   data-ctx-entity-type   an EntityLinkType (lib/entity-links.ts): opportunity, solution, task, ...
//   data-ctx-entity-id     the entity's UUID
//   data-ctx-entity-title  optional, human title (can sit on an outer container)
//   data-ctx-field         optional, human label of the field wrapper ("Description")
//
// The resolver walks up from the selection: nearest field, nearest entity. When
// nothing is annotated it falls back to what the URL says is open (a detail
// panel's `?detail=`, or an entity's own page), reusing parseEntityLink so the
// vocabulary is the same one the agent's page context uses.

import { entityPath, isEntityId, parseEntityLink, type EntityLinkType } from "@/lib/entity-links"

export type SelectionContext = {
  entityType: EntityLinkType
  entityId: string
  entityTitle?: string
  field?: string
  /** Relative link back to the entity. */
  url: string
}

export const CTX_TITLE_MAX = 120
export const CTX_FIELD_MAX = 60

const ENTITY_TYPES: ReadonlySet<string> = new Set<EntityLinkType>([
  "objective", "keyResult", "opportunity", "solution", "assumption", "experiment",
  "roadmapItem", "feedback", "task", "doc", "artifact",
])

const LABELS: Record<EntityLinkType, string> = {
  objective: "Objective",
  keyResult: "Key result",
  opportunity: "Opportunity",
  solution: "Solution",
  assumption: "Assumption",
  experiment: "Experiment",
  roadmapItem: "Roadmap item",
  feedback: "Feedback",
  task: "Task",
  doc: "Doc",
  artifact: "Artifact",
}

/** Workspaces can rename Opportunity and Solution; everything else is canonical. */
export function entityTypeLabel(type: EntityLinkType, overrides?: Partial<Record<EntityLinkType, string>>): string {
  return overrides?.[type] ?? LABELS[type]
}

/** One bounded line: a title or label cannot smuggle a newline-delimited fake section into a prompt. */
export function oneLine(value: string | null | undefined, max: number): string | undefined {
  const flat = value?.replace(/\s+/g, " ").trim()
  if (!flat) return undefined
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat
}

/** `ownerName` -> `Owner name`; used for field wrappers generated from an API field key. */
export function humanizeFieldKey(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim().toLowerCase()
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

const ENTITY_SELECTOR = "[data-ctx-entity-type][data-ctx-entity-id]"
const PANEL_SELECTOR = '[data-slot="pinned-panel"], [data-slot="sheet-content"]'

function elementOf(node: Node | null): Element | null {
  if (!node) return null
  return node instanceof Element ? node : node.parentElement
}

function readEntity(el: Element): { type: EntityLinkType; id: string; title?: string } | null {
  const type = el.getAttribute("data-ctx-entity-type") ?? ""
  const id = el.getAttribute("data-ctx-entity-id") ?? ""
  if (!ENTITY_TYPES.has(type) || !isEntityId(id)) return null
  return { type: type as EntityLinkType, id, title: oneLine(el.getAttribute("data-ctx-entity-title"), CTX_TITLE_MAX) }
}

export function resolveSelectionContext(
  start: Node | null,
  location: { pathname: string; search: string },
  slugs?: { orgSlug: string; workspaceSlug: string },
): SelectionContext | null {
  const origin = elementOf(start)
  if (!origin) return null

  const field = oneLine(origin.closest("[data-ctx-field]")?.getAttribute("data-ctx-field"), CTX_FIELD_MAX)

  // Nearest annotated entity; its title may be declared on an outer container of the same entity.
  let nearest: ReturnType<typeof readEntity> = null
  for (let el: Element | null = origin.closest(ENTITY_SELECTOR); el; el = el.parentElement?.closest(ENTITY_SELECTOR) ?? null) {
    const found = readEntity(el)
    if (!found) continue
    if (!nearest) nearest = found
    if (found.type === nearest.type && found.id === nearest.id && found.title) {
      nearest = { ...nearest, title: found.title }
      break
    }
  }

  const base = slugs ?? slugsFromPath(location.pathname)
  if (nearest && base) {
    return {
      entityType: nearest.type,
      entityId: nearest.id,
      ...(nearest.title ? { entityTitle: nearest.title } : {}),
      ...(field ? { field } : {}),
      url: entityPath({ ...base, type: nearest.type, id: nearest.id }),
    }
  }

  // Fallback: what the URL says is open. A selection inside a detail panel is about the
  // `?detail=` entity; a selection anywhere else must not inherit a panel it is not in.
  const params = new URLSearchParams(location.search)
  if (!origin.closest(PANEL_SELECTOR)) params.delete("detail")
  const query = params.toString()
  const link = parseEntityLink(`${location.pathname}${query ? `?${query}` : ""}`)
  if (!link) return null
  return {
    entityType: link.type,
    entityId: link.id,
    ...(field ? { field } : {}),
    url: entityPath({ orgSlug: link.orgSlug, workspaceSlug: link.workspaceSlug, type: link.type, id: link.id }),
  }
}

function slugsFromPath(pathname: string): { orgSlug: string; workspaceSlug: string } | null {
  const [org, workspace] = pathname.split("/").filter(Boolean)
  if (!org || !workspace) return null
  try {
    return { orgSlug: decodeURIComponent(org), workspaceSlug: decodeURIComponent(workspace) }
  } catch {
    return null
  }
}

/**
 * The stable one-line header placed above a quoted selection in the prompt, in the
 * same vocabulary as the agent's page context ("Showing: Type "title" (id ...)").
 */
export function selectionSourceLine(context: SelectionContext, labelOverrides?: Partial<Record<EntityLinkType, string>>): string {
  const label = entityTypeLabel(context.entityType, labelOverrides)
  const title = context.entityTitle ? ` "${context.entityTitle.replace(/"/g, "'")}"` : ""
  return `Selected from: ${label}${title} (id ${context.entityId})${context.field ? ` — field: ${context.field}` : ""}`
}

/** Short label for the context chip: "Opportunity · Description". */
export function selectionChipLabel(context: SelectionContext, labelOverrides?: Partial<Record<EntityLinkType, string>>): string {
  const label = entityTypeLabel(context.entityType, labelOverrides)
  return context.field ? `${label} · ${context.field}` : label
}
