import type { CustomFieldDefinitionData } from "@/lib/types"

/**
 * Server-side URL-param parsing and validation for the roadmap timeline's
 * configurable grouping (`?groupBy=`). Kept separate from
 * components/roadmap/native-timeline/timeline-model.ts, which builds the
 * client-side `TimelineGrouping` (including closures) once this has decided
 * *which* mode and field are in effect — a function can't cross the
 * Server-to-Client-Component boundary as a prop, so this half must finish
 * entirely on the server.
 */

export type RoadmapGroupByParam = "phase" | "squad" | "none" | { customFieldId: string }

/**
 * Parses the raw `groupBy` search param. Follows the existing
 * omit-when-default convention (see hooks/use-url-state.ts): absent and the
 * literal `"phase"` both mean Phase. Anything that isn't one of the three
 * built-in literals is treated as a candidate `CustomFieldDefinition` id —
 * `resolveRoadmapGroupBy` is what validates it.
 */
export function parseGroupByParam(raw: string | string[] | undefined): RoadmapGroupByParam {
  const value = Array.isArray(raw) ? raw[0] : raw
  if (!value || value === "phase") return "phase"
  if (value === "squad") return "squad"
  if (value === "none") return "none"
  return { customFieldId: value }
}

export type ResolvedRoadmapGroupBy =
  | { mode: "phase" }
  | { mode: "squad" }
  | { mode: "none" }
  | { mode: "customField"; field: CustomFieldDefinitionData }

/**
 * Resolves a parsed `groupBy` param against the workspace's actual custom
 * field definitions. Only SELECT-type ROADMAP_ITEM fields are groupable —
 * MULTI_SELECT is out of scope for v1 (an item could belong to more than one
 * group, which breaks one-row-per-item lane packing). An unknown or stale
 * field id (deleted, retyped to MULTI_SELECT, wrong object type) falls back
 * to Phase rather than erroring, exactly like an unrecognized `groupBy`
 * literal would.
 */
export function resolveRoadmapGroupBy(
  param: RoadmapGroupByParam,
  roadmapFieldDefs: readonly CustomFieldDefinitionData[]
): ResolvedRoadmapGroupBy {
  if (param === "phase") return { mode: "phase" }
  if (param === "squad") return { mode: "squad" }
  if (param === "none") return { mode: "none" }
  const field = roadmapFieldDefs.find((candidate) => candidate.id === param.customFieldId && candidate.fieldType === "SELECT")
  return field ? { mode: "customField", field } : { mode: "phase" }
}
