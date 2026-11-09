/**
 * Data and grouping for the Experiments Gallery view (`/experiments?view=gallery`).
 *
 * Each experiment is one card whose hero is the screenshot of an Artifact linked to the
 * experiment. This is the pure, client-safe half (types, URL parsing, grouping); the DB loader
 * is ./gallery-server, and the UI is components/experiments/experiments-gallery.tsx.
 */
import { EXPERIMENT_BOARD_STATUSES } from "@/lib/experiments/board-layout"
import type { Conclusion, ExperimentStatus, SquadData } from "@/lib/types"

export type ExperimentsView = "board" | "gallery"

/** The Gallery is `?view=gallery`; the Board is the default, so any other value (or none) is the Board. */
export function parseExperimentsView(raw: string | string[] | undefined): ExperimentsView {
  return raw === "gallery" ? "gallery" : "board"
}

export const EXPERIMENT_GALLERY_GROUP_MODES = ["status", "squad", "conclusion", "none"] as const
export type ExperimentGalleryGroupMode = (typeof EXPERIMENT_GALLERY_GROUP_MODES)[number]

/** `?groupBy=`: status (the board's columns) is the default. */
export function parseExperimentGalleryGroupMode(raw: string | string[] | undefined): ExperimentGalleryGroupMode {
  return (EXPERIMENT_GALLERY_GROUP_MODES as readonly string[]).includes(raw as string) ? (raw as ExperimentGalleryGroupMode) : "status"
}

export type ExperimentGalleryItem = {
  id: string
  title: string
  hypothesis: string
  status: ExperimentStatus
  conclusion: string | null
  squad: SquadData | null
}

export type ExperimentGalleryGroup = { key: string; label: string; color: string | null; items: ExperimentGalleryItem[] }

export const EXPERIMENT_STATUS_LABEL: Record<ExperimentStatus, string> = {
  DESIGNING: "Designing",
  RUNNING: "Running",
  COMPLETE: "Complete",
  KILLED: "Killed",
  NOT_PURSUED: "Not Pursued",
}

export const EXPERIMENT_STATUS_TONE: Record<ExperimentStatus, "neutral" | "info" | "success" | "danger"> = {
  DESIGNING: "neutral", RUNNING: "info", COMPLETE: "success", KILLED: "danger", NOT_PURSUED: "neutral",
}

export const EXPERIMENT_CONCLUSION_LABEL: Record<Conclusion, string> = {
  PROCEED: "Proceed",
  ITERATE: "Iterate",
  KILL: "Kill",
  NOT_PURSUED: "Not Pursued",
}
const CONCLUSION_ORDER: readonly string[] = ["PROCEED", "ITERATE", "KILL", "NOT_PURSUED"]
const NO_CONCLUSION_KEY = "NO_CONCLUSION"
const NO_SQUAD_KEY = "NO_SQUAD"

/** Groups cards for the gallery. Empty groups are dropped; item order inside a group is the input order. */
export function groupExperimentGalleryItems(
  items: readonly ExperimentGalleryItem[],
  mode: ExperimentGalleryGroupMode,
  ctx: { squads: readonly SquadData[] },
): ExperimentGalleryGroup[] {
  if (mode === "none") return items.length ? [{ key: "all", label: "All experiments", color: null, items: [...items] }] : []

  const buckets = new Map<string, ExperimentGalleryItem[]>()
  const keyOf = (item: ExperimentGalleryItem): string => {
    if (mode === "status") return item.status
    if (mode === "squad") return item.squad?.id ?? NO_SQUAD_KEY
    return item.conclusion ?? NO_CONCLUSION_KEY
  }
  for (const item of items) {
    const key = keyOf(item)
    buckets.set(key, [...(buckets.get(key) ?? []), item])
  }

  let order: readonly string[]
  let label: (key: string) => string
  let color: (key: string) => string | null = () => null
  if (mode === "status") {
    order = EXPERIMENT_BOARD_STATUSES
    label = (key) => EXPERIMENT_STATUS_LABEL[key as ExperimentStatus] ?? key
  } else if (mode === "squad") {
    order = [...ctx.squads.map((squad) => squad.id), NO_SQUAD_KEY]
    label = (key) => ctx.squads.find((squad) => squad.id === key)?.name ?? "No squad"
    color = (key) => ctx.squads.find((squad) => squad.id === key)?.color ?? null
  } else {
    order = [...CONCLUSION_ORDER, NO_CONCLUSION_KEY]
    label = (key) => (key === NO_CONCLUSION_KEY ? "No conclusion" : EXPERIMENT_CONCLUSION_LABEL[key as Conclusion] ?? key)
  }
  // Unknown keys (a status or conclusion added later, or a squad no longer listed) still render, after the known ones.
  const keys = [...order.filter((key) => buckets.has(key)), ...[...buckets.keys()].filter((key) => !order.includes(key))]
  return keys.map((key) => ({ key, label: label(key), color: color(key), items: buckets.get(key)! }))
}
