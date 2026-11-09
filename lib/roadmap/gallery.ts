/**
 * Data and grouping for the roadmap Gallery view (`?view=gallery`).
 *
 * Each roadmap item is shown as one large card whose hero is the screenshot of an
 * Artifact linked to the item's Solution. This module is the pure, client-safe half (types + grouping; the DB loader is in ./gallery-server); the
 * card UI lives in components/roadmap/roadmap-gallery.tsx.
 */
import type { GalleryArtifactSet } from "@/lib/gallery/artifacts"
import type { RoadmapCardData } from "@/components/roadmap/roadmap-card"
import type { SquadData } from "@/lib/types"

// The artifact DTO and its limits are shared with the Experiments Gallery (lib/gallery/artifacts).
export { MAX_GALLERY_ARTIFACTS_PER_ITEM, isCapturableSource, type GalleryArtifact } from "@/lib/gallery/artifacts"

export type GalleryItemExtras = GalleryArtifactSet & {
  solutionStatus: string | null
}

/* ------------------------------------------------------------------ grouping */

export type GalleryGroupMode = "status" | "horizon" | "squad" | "none"

export type GalleryGroup = { key: string; label: string; color: string | null; items: RoadmapCardData[] }

const SOLUTION_STATUS_LABELS: Record<string, string> = {
  IDEA: "Idea",
  VALIDATED: "Validated",
  IN_DELIVERY: "In delivery",
  SHIPPED: "Shipped",
}
const SOLUTION_STATUS_ORDER = ["IN_DELIVERY", "VALIDATED", "IDEA", "SHIPPED"]
const NO_SOLUTION_KEY = "NO_SOLUTION"

const HORIZON_LABELS: Record<string, string> = { NOW: "Now", NEXT: "Next", LATER: "Later", LAUNCHING: "Launching", LAUNCHED: "Launched", SHIPPED: "Shipped" }
const HORIZON_ORDER = ["NOW", "NEXT", "LATER", "LAUNCHING", "LAUNCHED", "SHIPPED"]

/** Groups cards for the gallery. Empty groups are dropped; item order inside a group is the input order. */
export function groupGalleryItems(
  items: readonly RoadmapCardData[],
  mode: GalleryGroupMode,
  ctx: { squads: readonly SquadData[]; extras: Readonly<Record<string, GalleryItemExtras>>; noSolutionLabel?: string },
): GalleryGroup[] {
  if (mode === "none") return items.length ? [{ key: "all", label: "All items", color: null, items: [...items] }] : []

  const buckets = new Map<string, RoadmapCardData[]>()
  const keyOf = (item: RoadmapCardData): string => {
    if (mode === "horizon") return item.horizon
    if (mode === "squad") return item.squad?.id ?? "NO_SQUAD"
    return ctx.extras[item.id]?.solutionStatus ?? NO_SOLUTION_KEY
  }
  for (const item of items) {
    const key = keyOf(item)
    buckets.set(key, [...(buckets.get(key) ?? []), item])
  }

  let order: string[]
  let label: (key: string) => string
  let color: (key: string) => string | null = () => null
  if (mode === "horizon") {
    order = HORIZON_ORDER
    label = (key) => HORIZON_LABELS[key] ?? key
  } else if (mode === "squad") {
    order = [...ctx.squads.map((squad) => squad.id), "NO_SQUAD"]
    label = (key) => ctx.squads.find((squad) => squad.id === key)?.name ?? "No squad"
    color = (key) => ctx.squads.find((squad) => squad.id === key)?.color ?? null
  } else {
    order = [...SOLUTION_STATUS_ORDER, NO_SOLUTION_KEY]
    label = (key) => (key === NO_SOLUTION_KEY ? ctx.noSolutionLabel ?? "No solution" : SOLUTION_STATUS_LABELS[key] ?? key)
  }
  // Unknown keys (a status added later) still render, after the known ones.
  const keys = [...order.filter((key) => buckets.has(key)), ...[...buckets.keys()].filter((key) => !order.includes(key))]
  return keys.map((key) => ({ key, label: label(key), color: color(key), items: buckets.get(key)! }))
}
