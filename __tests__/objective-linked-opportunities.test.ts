import { describe, expect, it } from "vitest"
import {
  assembleLinkedOpportunities,
  type LinkedOpportunityInput,
} from "@/lib/objective-linked-opportunities"

const opp = (id: string, title: string, raw: number | null, extra: Partial<LinkedOpportunityInput> = {}): LinkedOpportunityInput => ({
  id,
  title,
  status: "EXPLORING",
  score: raw === null ? null : { rawScore: raw, normalizedScore: raw / 50, modelVersion: 1 },
  ...extra,
})

describe("assembleLinkedOpportunities", () => {
  it("returns an empty list when nothing is linked", () => {
    expect(assembleLinkedOpportunities({ direct: [], viaKeyResults: [], liveModelVersion: 1 })).toEqual({ scoringActive: true, items: [] })
  })

  it("lists directly linked opportunities and marks them direct", () => {
    const { items } = assembleLinkedOpportunities({ direct: [opp("a", "Alpha", 10)], viaKeyResults: [], liveModelVersion: 1 })
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ id: "a", title: "Alpha", status: "EXPLORING", direct: true, viaKeyResults: [], rawScore: 10 })
  })

  it("lists opportunities linked through key results and names the key result", () => {
    const { items } = assembleLinkedOpportunities({
      direct: [],
      viaKeyResults: [{ keyResult: { id: "kr1", title: "KR One" }, opportunities: [opp("b", "Beta", 5)] }],
      liveModelVersion: 1,
    })
    expect(items[0]).toMatchObject({ id: "b", direct: false, viaKeyResults: [{ id: "kr1", title: "KR One" }] })
  })

  it("dedupes by opportunity id across direct and several key results", () => {
    const shared = opp("c", "Gamma", 7)
    const { items } = assembleLinkedOpportunities({
      direct: [shared, opp("a", "Alpha", 1)],
      viaKeyResults: [
        { keyResult: { id: "kr2", title: "Second" }, opportunities: [shared] },
        { keyResult: { id: "kr1", title: "First" }, opportunities: [shared, opp("b", "Beta", 2)] },
      ],
      liveModelVersion: 1,
    })
    expect(items.map((i) => i.id).sort()).toEqual(["a", "b", "c"])
    const c = items.find((i) => i.id === "c")!
    expect(c.direct).toBe(true)
    expect(c.viaKeyResults.map((k) => k.title)).toEqual(["First", "Second"])
  })

  it("sorts by raw score descending (not normalized), unscored last, ties by title then id", () => {
    const { items } = assembleLinkedOpportunities({
      direct: [
        opp("u2", "Zed unscored", null),
        opp("lo", "Low", 3),
        opp("hi", "High", 4000, { score: { rawScore: 4000, normalizedScore: 1, modelVersion: 1 } }),
        opp("t2", "Tie B", 50),
        opp("t1", "Tie A", 50),
        opp("u1", "Alpha unscored", null),
        opp("t0", "Tie A", 50),
      ],
      viaKeyResults: [],
      liveModelVersion: 1,
    })
    expect(items.map((i) => i.id)).toEqual(["hi", "t0", "t1", "t2", "lo", "u1", "u2"])
  })

  it("treats a zero raw score as scored, ahead of unscored", () => {
    const { items } = assembleLinkedOpportunities({ direct: [opp("n", "None", null), opp("z", "Zero", 0)], viaKeyResults: [], liveModelVersion: 1 })
    expect(items.map((i) => i.id)).toEqual(["z", "n"])
  })

  it("flags a score saved under an older model version as stale", () => {
    const { items } = assembleLinkedOpportunities({
      direct: [opp("a", "A", 1, { score: { rawScore: 1, normalizedScore: 1, modelVersion: 1 } })],
      viaKeyResults: [],
      liveModelVersion: 2,
    })
    expect(items[0].scoreStale).toBe(true)
  })

  it("keeps raw-descending order even when the top score is stale (the stale flag is a marker, not a demotion)", () => {
    const { items } = assembleLinkedOpportunities({
      direct: [
        opp("fresh", "Fresh", 100, { score: { rawScore: 100, normalizedScore: 2, modelVersion: 2 } }),
        opp("stale", "Stale", 900, { score: { rawScore: 900, normalizedScore: 18, modelVersion: 1 } }),
      ],
      viaKeyResults: [],
      liveModelVersion: 2,
    })
    expect(items.map((i) => i.id)).toEqual(["stale", "fresh"])
    expect(items.map((i) => i.scoreStale)).toEqual([true, false])
  })

  it("omits every score field when the workspace has no active model, sorting by status then title", () => {
    const result = assembleLinkedOpportunities({
      direct: [
        opp("e", "Exploring", 99, { status: "EXPLORING" }),
        opp("ar", "Archived", 100, { status: "ARCHIVED" }),
        opp("ac2", "Active B", 1, { status: "ACTIVE" }),
        opp("ac1", "Active A", null, { status: "ACTIVE" }),
        opp("p", "Prioritized", 1, { status: "PRIORITIZED" }),
        opp("v", "Validating", 1, { status: "VALIDATING" }),
      ],
      viaKeyResults: [],
      liveModelVersion: null,
    })
    expect(result.scoringActive).toBe(false)
    expect(result.items.map((i) => i.id)).toEqual(["ac1", "ac2", "p", "v", "e", "ar"])
    for (const item of result.items) {
      expect(item).not.toHaveProperty("rawScore")
      expect(item).not.toHaveProperty("normalizedScore")
      expect(item).not.toHaveProperty("scoreStale")
    }
  })

  it("keeps the unscored row's score fields null (not omitted) when a model is active", () => {
    const { items } = assembleLinkedOpportunities({ direct: [opp("a", "A", null)], viaKeyResults: [], liveModelVersion: 1 })
    expect(items[0]).toMatchObject({ rawScore: null, normalizedScore: null, scoreStale: false })
  })
})
