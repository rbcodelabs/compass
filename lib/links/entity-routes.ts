import type { LinkableEntityType } from "@/lib/entity-types"

/**
 * Where a linked entity opens, relative to `/<org>/<workspace>`. Client-safe (no registry, no database).
 * A type with no page of its own is simply absent and its rows render as plain text.
 */
const ENTITY_PATHS: Partial<Record<LinkableEntityType, (id: string) => string>> = {
  EXPERIMENT: (id) => `experiments/${id}`,
  RESEARCH_STUDY: (id) => `capture/studies/${id}`,
}

export function entityPath(type: LinkableEntityType, id: string): string | null {
  return ENTITY_PATHS[type]?.(id) ?? null
}
