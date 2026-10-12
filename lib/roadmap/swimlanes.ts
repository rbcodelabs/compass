import type { SelectOption } from "@/lib/types"

/**
 * Swimlane model for the roadmap Board. Lanes are rows; the horizon columns
 * stay the columns. A card belongs to exactly one lane, chosen by its squad or
 * by its value for one SELECT custom field. Everything here is pure and
 * serializable so the server page can build the spec and the client board can
 * bucket cards and apply optimistic lane changes without a round trip.
 */

export const UNASSIGNED_LANE_KEY = "unassigned"

export type SwimlaneSquad = { id: string; name: string; color: string }

export type SwimlaneSpec =
  | { mode: "squad"; squads: readonly SwimlaneSquad[] }
  | {
      mode: "customField"
      fieldId: string
      fieldName: string
      options: readonly SelectOption[]
      /** Stored value per roadmap item id (SELECT values are option `value` strings). */
      valuesByItemId: Readonly<Record<string, unknown>>
    }

export type Lane = {
  /** Stable DOM / droppable-safe key. */
  key: string
  label: string
  color: string | null
  /** Squad id or option value the lane stands for; `null` is the Unassigned lane. */
  value: string | null
}

/** The minimal card shape lanes need, so the lib does not depend on a component. */
export type LaneCard = { id: string; squad: SwimlaneSquad | null }

export function laneKeyForValue(spec: SwimlaneSpec, value: string | null): string {
  if (value === null) return UNASSIGNED_LANE_KEY
  return spec.mode === "squad" ? `squad:${value}` : `option:${value}`
}

/** Every lane, in display order: squads by given order / options by option order, Unassigned last. */
export function buildLanes(spec: SwimlaneSpec, unassignedLabel?: string): Lane[] {
  const label = unassignedLabel ?? (spec.mode === "squad" ? "No squad" : `No ${spec.fieldName}`)
  const lanes: Lane[] =
    spec.mode === "squad"
      ? spec.squads.map((squad) => ({ key: laneKeyForValue(spec, squad.id), label: squad.name, color: squad.color, value: squad.id }))
      : spec.options.map((option) => ({ key: laneKeyForValue(spec, option.value), label: option.label, color: option.color ?? null, value: option.value }))
  lanes.push({ key: UNASSIGNED_LANE_KEY, label, color: null, value: null })
  return lanes
}

/**
 * The lane a card sits in. A squad or option value that is no longer in the
 * spec (deleted option, squad hidden by a filter) falls into Unassigned, which
 * matches how the timeline groups stale values.
 */
export function laneKeyForCard(spec: SwimlaneSpec, card: LaneCard): string {
  if (spec.mode === "squad") {
    const id = card.squad?.id
    return id && spec.squads.some((squad) => squad.id === id) ? laneKeyForValue(spec, id) : UNASSIGNED_LANE_KEY
  }
  const raw = spec.valuesByItemId[card.id]
  return typeof raw === "string" && spec.options.some((option) => option.value === raw) ? laneKeyForValue(spec, raw) : UNASSIGNED_LANE_KEY
}

export function cardsInLane<T extends LaneCard>(spec: SwimlaneSpec, cards: readonly T[], laneKey: string): T[] {
  return cards.filter((card) => laneKeyForCard(spec, card) === laneKey)
}

/** Count of cards per lane key; lanes with no cards are present with 0. */
export function laneCounts(spec: SwimlaneSpec, lanes: readonly Lane[], cards: readonly LaneCard[]): Record<string, number> {
  const counts: Record<string, number> = Object.fromEntries(lanes.map((lane) => [lane.key, 0]))
  for (const card of cards) {
    const key = laneKeyForCard(spec, card)
    counts[key] = (counts[key] ?? 0) + 1
  }
  return counts
}

/**
 * Optimistically move a card to a lane. Returns the updated spec (custom field:
 * a new values map) and the card with its squad updated (squad mode). Inputs are
 * never mutated.
 */
export function assignCardToLane<T extends LaneCard>(
  spec: SwimlaneSpec,
  card: T,
  lane: Lane,
): { spec: SwimlaneSpec; card: T } {
  if (spec.mode === "squad") {
    const squad = lane.value === null ? null : (spec.squads.find((candidate) => candidate.id === lane.value) ?? null)
    return { spec, card: { ...card, squad } }
  }
  const next = { ...spec.valuesByItemId }
  if (lane.value === null) delete next[card.id]
  else next[card.id] = lane.value
  return { spec: { ...spec, valuesByItemId: next }, card }
}

/** True when moving `card` into `lane` would not change its lane. */
export function isSameLane(spec: SwimlaneSpec, card: LaneCard, laneKey: string): boolean {
  return laneKeyForCard(spec, card) === laneKey
}

/** Droppable id for one lane x horizon cell. Lane keys contain no `|`. */
export function cellDroppableId(laneKey: string, horizon: string): string {
  return `cell|${laneKey}|${horizon}`
}

export function parseCellDroppableId(id: string): { laneKey: string; horizon: string } | null {
  const parts = id.split("|")
  if (parts.length !== 3 || parts[0] !== "cell") return null
  return { laneKey: parts[1], horizon: parts[2] }
}
