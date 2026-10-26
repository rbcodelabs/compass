/**
 * How an embedded record is drawn in its compact card row: which glyph and tone stand for a status, and which one fact is shown beside the
 * title. Pure: no DB, no React (the SVG lives in components/docs/embed-card-icons.tsx).
 *
 * Statuses are the real stored values: the editable lists in lib/spec-docs/card-edit.ts, the roadmap/artifact `ACTIVE`/`ARCHIVED`, and the
 * metric health words from lib/analytics/dashboard-status.ts (lowercase, plus `ARCHIVED` for a metric whose definition was removed).
 * Shape carries the meaning and colour only reinforces it. A status not listed here returns null and the card falls back to a text pill, so
 * a new status value never renders as a wrong glyph.
 */
import type { DocEmbedKind } from "@/lib/doc-embeds"

export type StatusGlyphName =
  | "notStarted" | "ready" | "progress" | "review" | "validated" | "done" | "stopped" | "disproved"
  | "blocked" | "archived" | "active" | "onTrack" | "atRisk" | "offTrack" | "stale"

export type StatusTone = "neutral" | "progress" | "done" | "warn" | "danger"

export type StatusVisual = { glyph: StatusGlyphName; tone: StatusTone; label: string }

const GLYPH_TONE: Record<StatusGlyphName, StatusTone> = {
  notStarted: "neutral", ready: "neutral", progress: "progress", review: "progress", validated: "done", done: "done",
  stopped: "neutral", disproved: "danger", blocked: "danger", archived: "neutral", active: "progress",
  onTrack: "done", atRisk: "warn", offTrack: "danger", stale: "warn",
}

type Entry = readonly [value: string, glyph: StatusGlyphName, label: string]

const STATUS_TABLE: Partial<Record<DocEmbedKind, readonly Entry[]>> = {
  opportunity: [["EXPLORING", "notStarted", "Exploring"], ["VALIDATING", "progress", "Validating"], ["PRIORITIZED", "ready", "Prioritized"], ["ACTIVE", "active", "Active"], ["ARCHIVED", "archived", "Archived"]],
  solution: [["IDEA", "notStarted", "Idea"], ["VALIDATED", "validated", "Validated"], ["IN_DELIVERY", "progress", "In delivery"], ["SHIPPED", "done", "Shipped"], ["KILLED", "stopped", "Killed"]],
  assumption: [["UNTESTED", "notStarted", "Untested"], ["TESTING", "progress", "Testing"], ["VALIDATED", "validated", "Validated"], ["INVALIDATED", "disproved", "Invalidated"]],
  experiment: [["DESIGNING", "notStarted", "Designing"], ["RUNNING", "progress", "Running"], ["COMPLETE", "done", "Complete"], ["KILLED", "stopped", "Killed"]],
  task: [["BACKLOG", "notStarted", "Backlog"], ["TODO", "ready", "To do"], ["IN_PROGRESS", "progress", "In progress"], ["BLOCKED", "blocked", "Blocked"], ["IN_REVIEW", "review", "In review"], ["DONE", "done", "Done"], ["CANCELLED", "stopped", "Cancelled"]],
  objective: [["ON_TRACK", "onTrack", "On track"], ["AT_RISK", "atRisk", "At risk"], ["OFF_TRACK", "offTrack", "Off track"], ["COMPLETE", "done", "Complete"]],
  roadmapItem: [["ACTIVE", "active", "Active"], ["ARCHIVED", "archived", "Archived"]],
  artifact: [["ACTIVE", "active", "Active"], ["ARCHIVED", "archived", "Archived"]],
  metric: [["fresh", "onTrack", "Up to date"], ["stale", "stale", "Stale"], ["failed", "offTrack", "Sync failed"], ["ARCHIVED", "archived", "Archived"]],
}

/** The glyph, tone and label for a record's status, or null when the kind has no status or the value is not a known one. */
export function statusVisual(kind: DocEmbedKind, status: string | null | undefined): StatusVisual | null {
  if (!status) return null
  const entry = STATUS_TABLE[kind]?.find(([value]) => value === status)
  return entry ? { glyph: entry[1], tone: GLYPH_TONE[entry[1]], label: entry[2] } : null
}

/** The fact label to prefer in the compact row, in order, per kind. The first one the card actually has wins; none means no fact is shown. */
const PEEK_LABELS: Record<DocEmbedKind, readonly string[]> = {
  opportunity: ["Score"],
  solution: ["Score"],
  assumption: ["Risk"],
  experiment: ["Ends", "Conclusion"],
  task: ["Due", "Priority"],
  objective: ["Progress"],
  keyResult: ["Progress"],
  metric: ["Latest"],
  roadmapItem: ["Horizon"],
  artifact: ["Type"],
  doc: ["Type"],
}

/** The one fact shown beside the title in the compact row, as "Label value" (or just the value for a self-describing fact), or null. */
export function peekFact(kind: DocEmbedKind, facts: readonly { label: string; value: string }[]): string | null {
  for (const label of PEEK_LABELS[kind]) {
    const found = facts.find((fact) => fact.label === label)
    if (found) return label === "Latest" || label === "Horizon" || label === "Type" ? found.value : `${label} ${found.value}`
  }
  return null
}
