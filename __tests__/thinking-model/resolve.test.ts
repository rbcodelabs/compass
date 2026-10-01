import { describe, expect, it } from "vitest"
import { inspectStoredLabels, resolveThinkingModel } from "@/lib/thinking-model/resolve"
import { THINKING_MODEL_KEYS } from "@/lib/thinking-model/presets"
import { derivePlural, toLowerLabel } from "@/lib/thinking-model/labels"

const classic = resolveThinkingModel({ thinkingModel: "CLASSIC", thinkingModelLabels: null })
const stored = (value: unknown) => JSON.stringify(value)

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
    const r = resolveThinkingModel({ thinkingModel: "NOPE", thinkingModelLabels: stored({ objective: { singular: "Goal" } }) })
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

  it("OPPORTUNITY_FIRST_OKR resolves with CLASSIC labels and the pool tree", () => {
    const r = resolveThinkingModel({ thinkingModel: "OPPORTUNITY_FIRST_OKR" })
    expect(r.key).toBe("OPPORTUNITY_FIRST_OKR")
    expect(r.labels).toEqual(classic.labels)
    expect(r.tree).toBe("objective-rooted-pool")
  })

  it("merges overrides over the preset and derives lower/plural forms", () => {
    const r = resolveThinkingModel({
      thinkingModel: "TORRES_OST",
      thinkingModelLabels: stored({ objective: { singular: "Theme", plural: "Themes" }, keyResult: { singular: "Signal" } }),
    })
    expect(r.labels.objective).toMatchObject({ singular: "Theme", plural: "Themes", lower: "theme", lowerPlural: "themes" })
    expect(r.labels.keyResult).toMatchObject({ singular: "Signal", plural: "Signals", short: "Signal", sentence: "Signal" })
    expect(r.labels.sections.okrs).toBe("Themes")
    expect(r.hasLabelOverrides).toBe(true)
  })

  it("an override drops the preset's article, so copy cannot say 'a idea'", () => {
    const r = resolveThinkingModel({ thinkingModel: "CLASSIC", thinkingModelLabels: stored({ objective: { singular: "Idea" } }) })
    expect(r.labels.objective.indefinite).toBe("idea")
    expect(classic.labels.objective.indefinite).toBe("an objective")
    expect(classic.labels.keyResult.indefinite).toBe("a key result")
    expect(classic.labels.opportunity.indefinite).toBe("an opportunity")
    expect(classic.labels.solution.indefinite).toBe("a solution")
    expect(resolveThinkingModel({ thinkingModel: "TORRES_OST" }).labels.objective.indefinite).toBe("an outcome")
  })

  describe("stored overrides are re-validated on every read (all or nothing)", () => {
    const cases: Array<[string, unknown]> = [
      ["an unknown entity key", { objective: { singular: "Goal" }, roadmapItem: { singular: "Bet" } }],
      ["a reserved nav name", { objective: { singular: "Roadmap" } }],
      ["a full-width reserved nav name", { objective: { singular: "ＲＯＡＤＭＡＰ" } }],
      ["markup", { objective: { singular: "<b>Goal</b>" } }],
      ["an over-long label", { objective: { singular: "x".repeat(33) } }],
      ["a collision with another entity", { objective: { singular: "Solution" } }],
      ["a collision between two of the newly overridable entities", { cycle: { singular: "Sprint" }, solution: { singular: "Sprint" } }],
      ["a reserved nav name on an opportunity", { opportunity: { singular: "Roadmap" } }],
      ["an unknown inner key", { objective: { singular: "Goal", extra: "x" } }],
    ]
    it.each(cases)("%s => no overrides at all", (_name, value) => {
      expect(resolveThinkingModel({ thinkingModel: "CLASSIC", thinkingModelLabels: stored(value) })).toEqual(classic)
    })
  })

  describe("inspectStoredLabels agrees with the resolver about what is applied", () => {
    it("nothing stored: nothing applied, nothing to warn about", () => {
      expect(inspectStoredLabels({})).toEqual({ applied: {}, unapplied: null })
      expect(inspectStoredLabels({ thinkingModelLabels: "  " })).toEqual({ applied: {}, unapplied: null })
      expect(inspectStoredLabels({ thinkingModel: "CLASSIC", thinkingModelLabels: "{}" })).toEqual({ applied: {}, unapplied: null })
    })

    it("valid stored labels are applied, not flagged", () => {
      const raw = stored({ objective: { singular: "Goal" } })
      expect(inspectStoredLabels({ thinkingModel: "CLASSIC", thinkingModelLabels: raw })).toEqual({
        applied: { objective: { singular: "Goal" } },
        unapplied: null,
      })
    })

    it("an unknown stored key means NOTHING is applied and the raw text comes back", () => {
      const raw = stored({ objective: { singular: "Goal" } })
      expect(inspectStoredLabels({ thinkingModel: "FUTURE_MODEL", thinkingModelLabels: raw })).toEqual({ applied: {}, unapplied: raw })
      expect(resolveThinkingModel({ thinkingModel: "FUTURE_MODEL", thinkingModelLabels: raw }).hasLabelOverrides).toBe(false)
    })

    it.each(["{not json", stored({ roadmapItem: { singular: "Bet" } }), stored({ objective: { singular: "Roadmap" } })])(
      "stored but failing today's rules (%s) is reported, never silently dropped",
      (raw) => {
        expect(inspectStoredLabels({ thinkingModel: "CLASSIC", thinkingModelLabels: raw })).toEqual({ applied: {}, unapplied: raw })
        expect(resolveThinkingModel({ thinkingModel: "CLASSIC", thinkingModelLabels: raw })).toEqual(classic)
      },
    )
  })

  describe("opportunity, solution and cycle overrides apply (they were rejected before Phase 4C-2)", () => {
    it("a stored override for a previously non-overridable entity now simply applies", () => {
      const raw = stored({ solution: { singular: "Bet" }, opportunity: { singular: "Problem", plural: "Problems" }, cycle: { singular: "Sprint" } })
      const r = resolveThinkingModel({ thinkingModel: "CLASSIC", thinkingModelLabels: raw })
      expect(r.hasLabelOverrides).toBe(true)
      expect(r.labels.solution).toMatchObject({ singular: "Bet", plural: "Bets", lower: "bet", lowerPlural: "bets", indefinite: "bet" })
      expect(r.labels.opportunity).toMatchObject({ singular: "Problem", plural: "Problems", lower: "problem", indefinite: "problem" })
      expect(r.labels.cycle).toMatchObject({ singular: "Sprint", plural: "Sprints", lower: "sprint" })
      // Untouched entities keep the preset's words and articles.
      expect(r.labels.objective).toEqual(classic.labels.objective)
      expect(inspectStoredLabels({ thinkingModel: null, thinkingModelLabels: raw })).toEqual({
        applied: { solution: { singular: "Bet" }, opportunity: { singular: "Problem", plural: "Problems" }, cycle: { singular: "Sprint" } },
        unapplied: null,
      })
    })

    it("all five entities renamed at once under Torres", () => {
      const labels = {
        opportunity: { singular: "Need" },
        objective: { singular: "Aim" },
        keyResult: { singular: "Signal", plural: "Signals" },
        solution: { singular: "Bet" },
        cycle: { singular: "Sprint" },
      }
      const r = resolveThinkingModel({ thinkingModel: "TORRES_OST", thinkingModelLabels: stored(labels) })
      expect(r.labels.opportunity.plural).toBe("Needs")
      expect(r.labels.sections.okrs).toBe("Aims")
      expect(r.labels.cycle.plural).toBe("Sprints")
      expect(r.cycles).toBe("subdued")
    })

    it("a plural-less override of a y-noun is derived", () => {
      expect(resolveThinkingModel({ thinkingModelLabels: stored({ opportunity: { singular: "Story" } }) }).labels.opportunity.plural).toBe("Stories")
    })
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

  // Known naive cases: the settings form invites an explicit plural for these.
  it.each([
    ["Hero", "Heros"],
    ["Con", "Cons"],
  ])("naive: %s -> %s (give an explicit plural when this is wrong)", (s, p) => expect(derivePlural(s)).toBe(p))
})

describe("toLowerLabel", () => {
  it.each([
    ["Key Result", "key result"],
    ["Hero", "hero"],
    ["SKY", "SKY"],
    ["R&D need", "R&D need"],
    ["Success metric", "success metric"],
    ["Q", "q"],
  ])("%s -> %s", (s, l) => expect(toLowerLabel(s)).toBe(l))
})
