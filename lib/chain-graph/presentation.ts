/**
 * Renderer-agnostic presentation rules (still pure, so they are unit-tested): semantic-zoom bands and the per-type
 * glyph/series mapping. Thresholds are the prototype's; tune against real titles.
 */
import type { ChainNodeType } from "./types"

export type ZoomBand = "dot" | "label" | "full"

export const ZOOM_LABEL_AT = 0.5
export const ZOOM_FULL_AT = 1.1

/** Quantised so a store selector returns the same string for every wheel tick inside a band. */
export function zoomBand(zoom: number): ZoomBand {
  if (zoom < ZOOM_LABEL_AT) return "dot"
  if (zoom < ZOOM_FULL_AT) return "label"
  return "full"
}

/** Types whose label shows at the middle band (the prototype's "key labels"); clusters always do. */
const KEY_LABEL_TYPES: ReadonlySet<ChainNodeType> = new Set(["OBJECTIVE", "OPPORTUNITY"])

export function showsLabel(band: ZoomBand, type: ChainNodeType | "cluster"): boolean {
  if (band === "full") return true
  if (band === "dot") return false
  return type === "cluster" || KEY_LABEL_TYPES.has(type)
}

export const TYPE_LABEL: Record<ChainNodeType, string> = {
  OBJECTIVE: "Objective",
  OPPORTUNITY: "Opportunity",
  SOLUTION: "Solution",
  ASSUMPTION: "Assumption",
  EXPERIMENT: "Experiment",
  ROADMAP_ITEM: "Roadmap",
}

/** Series slot (1-based, --graph-series-N) per object type. Colour is paired with a distinct shape in the renderer. */
export const TYPE_SERIES: Record<ChainNodeType, number> = {
  OBJECTIVE: 1,
  OPPORTUNITY: 2,
  SOLUTION: 3,
  ASSUMPTION: 4,
  EXPERIMENT: 5,
  ROADMAP_ITEM: 6,
}

export const SERIES_COUNT = 9

/** Group clouds cycle the series by stable index (never by string hash). 1-based. */
export function seriesForGroupIndex(index: number): number {
  return (((index % SERIES_COUNT) + SERIES_COUNT) % SERIES_COUNT) + 1
}
