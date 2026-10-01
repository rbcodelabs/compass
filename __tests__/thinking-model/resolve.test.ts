import { describe, expect, it } from "vitest"
import { resolveThinkingModel } from "@/lib/thinking-model/resolve"
import { THINKING_MODEL_KEYS } from "@/lib/thinking-model/presets"
import { derivePlural } from "@/lib/thinking-model/labels"

const classic = resolveThinkingModel({ thinkingModel: "CLASSIC", thinkingModelLabels: null })

describe("resolveThinkingModel", () => {
  it("treats NULL as CLASSIC, deep-equal to the explicit key", () => {
    expect(resolveThinkingModel({ thinkingModel: null, thinkingModelLabels: null })).toEqual(classic)
    expect(resolveThinkingModel({})).toEqual(classic)
  })

  it("falls back to CLASSIC for an unknown key without throwing", () => {
    expect(resolveThinkingModel({ thinkingModel: "NOPE", thinkingModelLabels: null })).toEqual(classic)
  })

  it.each(["{not json", "[]", "null", "42", '"x"', '{"objective":5}'])(
    "ignores corrupt label JSON %s",
    (raw) => {
      expect(resolveThinkingModel({ thinkingModel: null, thinkingModelLabels: raw })).toEqual(classic)
    },
  )

  it("ignores overrides when the key is unknown (CLASSIC with no overrides)", () => {
    const r = resolveThinkingModel({
      thinkingModel: "NOPE",
      thinkingModelLabels: JSON.stringify({ objective: { singular: "Goal" } }),
    })
    expect(r).toEqual(classic)
  })

  it("exposes preset structure flags", () => {
    expect(classic.key).toBe("CLASSIC")
    expect(classic.tree).toBe("kr-rooted")
    expect(classic.cycles).toBe("standard")
    const torres = resolveThinkingModel({ thinkingModel: "TORRES_OST" })
    expect(torres.tree).toBe("outcome-rooted")
    expect(torres.cycles).toBe("subdued")
    expect(torres.labels.objective.singular).toBe("Outcome")
    expect(torres.labels.keyResult.singular).toBe("Success metric")
    expect(torres.labels.sections.okrs).toBe("Outcomes")
  })

  it("OPPORTUNITY_FIRST_OKR has CLASSIC labels", () => {
    const r = resolveThinkingModel({ thinkingModel: "OPPORTUNITY_FIRST_OKR" })
    expect(r.labels).toEqual(classic.labels)
    expect(r.tree).toBe("objective-rooted-pool")
  })

  it("merges overrides over the preset and derives lower/plural forms", () => {
    const r = resolveThinkingModel({
      thinkingModel: "TORRES_OST",
      thinkingModelLabels: JSON.stringify({
        objective: { singular: "Theme", plural: "Themes" },
        solution: { singular: "Bet" },
      }),
    })
    expect(r.labels.objective).toMatchObject({ singular: "Theme", plural: "Themes", lower: "theme", lowerPlural: "themes" })
    expect(r.labels.solution.plural).toBe("Bets")
    expect(r.labels.keyResult.singular).toBe("Success metric")
    expect(r.labels.sections.okrs).toBe("Themes")
  })

  it("every preset key resolves to itself", () => {
    for (const key of THINKING_MODEL_KEYS) expect(resolveThinkingModel({ thinkingModel: key }).key).toBe(key)
  })

  it("is serializable plain data (safe to hand to a client component)", () => {
    const r = resolveThinkingModel({ thinkingModel: "TORRES_OST" })
    expect(JSON.parse(JSON.stringify(r))).toEqual(r)
  })
})

describe("derivePlural", () => {
  it.each([
    ["Bet", "Bets"],
    ["Story", "Stories"],
    ["Day", "Days"],
    ["Focus", "Focuses"],
    ["Box", "Boxes"],
    ["Match", "Matches"],
    ["Key Result", "Key Results"],
  ])("%s -> %s", (s, p) => expect(derivePlural(s)).toBe(p))
})
