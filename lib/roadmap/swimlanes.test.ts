import { describe, expect, it } from "vitest"
import {
  UNASSIGNED_LANE_KEY,
  assignCardToLane,
  buildLanes,
  cardsInLane,
  cellDroppableId,
  laneCounts,
  laneKeyForCard,
  parseCellDroppableId,
  type SwimlaneSpec,
} from "./swimlanes"

const platform = { id: "sq1", name: "Platform", color: "#111111" }
const growth = { id: "sq2", name: "Growth", color: "#222222" }
const squadSpec: SwimlaneSpec = { mode: "squad", squads: [platform, growth] }

const fieldSpec: SwimlaneSpec = {
  mode: "customField",
  fieldId: "f1",
  fieldName: "Team",
  options: [
    { label: "Red", value: "red", color: "#f00" },
    { label: "Blue", value: "blue" },
  ],
  valuesByItemId: { a: "red", b: "blue", c: "gone", d: 42 },
}

describe("buildLanes", () => {
  it("lists every squad then an Unassigned lane, including empty squads", () => {
    const lanes = buildLanes(squadSpec)
    expect(lanes.map((lane) => lane.key)).toEqual(["squad:sq1", "squad:sq2", UNASSIGNED_LANE_KEY])
    expect(lanes[0]).toMatchObject({ label: "Platform", color: "#111111", value: "sq1" })
    expect(lanes[2]).toMatchObject({ label: "No squad", value: null })
  })

  it("lists options in option order and labels Unassigned after the field", () => {
    const lanes = buildLanes(fieldSpec)
    expect(lanes.map((lane) => lane.label)).toEqual(["Red", "Blue", "No Team"])
    expect(lanes[0].color).toBe("#f00")
    expect(lanes[1].color).toBeNull()
  })
})

describe("laneKeyForCard", () => {
  it("buckets by squad and sends unknown or missing squads to Unassigned", () => {
    expect(laneKeyForCard(squadSpec, { id: "x", squad: platform })).toBe("squad:sq1")
    expect(laneKeyForCard(squadSpec, { id: "x", squad: null })).toBe(UNASSIGNED_LANE_KEY)
    expect(laneKeyForCard(squadSpec, { id: "x", squad: { id: "other", name: "Z", color: "#000" } })).toBe(UNASSIGNED_LANE_KEY)
  })

  it("buckets by SELECT value and sends stale, non-string and absent values to Unassigned", () => {
    const card = (id: string) => ({ id, squad: null })
    expect(laneKeyForCard(fieldSpec, card("a"))).toBe("option:red")
    expect(laneKeyForCard(fieldSpec, card("b"))).toBe("option:blue")
    expect(laneKeyForCard(fieldSpec, card("c"))).toBe(UNASSIGNED_LANE_KEY)
    expect(laneKeyForCard(fieldSpec, card("d"))).toBe(UNASSIGNED_LANE_KEY)
    expect(laneKeyForCard(fieldSpec, card("missing"))).toBe(UNASSIGNED_LANE_KEY)
  })
})

describe("cardsInLane / laneCounts", () => {
  const cards = [
    { id: "1", squad: platform },
    { id: "2", squad: platform },
    { id: "3", squad: null },
  ]
  it("filters and counts, with empty lanes at zero", () => {
    expect(cardsInLane(squadSpec, cards, "squad:sq1").map((card) => card.id)).toEqual(["1", "2"])
    expect(laneCounts(squadSpec, buildLanes(squadSpec), cards)).toEqual({ "squad:sq1": 2, "squad:sq2": 0, [UNASSIGNED_LANE_KEY]: 1 })
  })
})

describe("assignCardToLane", () => {
  it("sets and clears the squad without mutating the input", () => {
    const card = { id: "1", squad: platform }
    const lanes = buildLanes(squadSpec)
    const moved = assignCardToLane(squadSpec, card, lanes[1])
    expect(moved.card.squad).toEqual(growth)
    expect(card.squad).toEqual(platform)
    expect(assignCardToLane(squadSpec, card, lanes[2]).card.squad).toBeNull()
  })

  it("sets and clears the field value in a copied map", () => {
    const card = { id: "a", squad: null }
    const lanes = buildLanes(fieldSpec)
    const toBlue = assignCardToLane(fieldSpec, card, lanes[1])
    expect(toBlue.spec.mode === "customField" && toBlue.spec.valuesByItemId.a).toBe("blue")
    expect(fieldSpec.mode === "customField" && fieldSpec.valuesByItemId.a).toBe("red")
    const cleared = assignCardToLane(fieldSpec, card, lanes[2])
    expect(cleared.spec.mode === "customField" && "a" in cleared.spec.valuesByItemId).toBe(false)
  })
})

describe("cell droppable ids", () => {
  it("round-trips and rejects other ids", () => {
    const id = cellDroppableId("squad:sq1", "NOW")
    expect(parseCellDroppableId(id)).toEqual({ laneKey: "squad:sq1", horizon: "NOW" })
    expect(parseCellDroppableId("column-NOW")).toBeNull()
  })
})
