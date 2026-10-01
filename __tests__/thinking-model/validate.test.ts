import { describe, expect, it } from "vitest"
import { validateLabelOverrides, MAX_LABEL_LENGTH, MAX_OVERRIDES_BYTES, RESERVED_NOUN_NAMES } from "@/lib/thinking-model/validate"
import { OVERRIDABLE_ENTITIES, THINKING_MODEL_ENTITIES } from "@/lib/thinking-model/presets"

const run = (input: unknown, key = "CLASSIC") => validateLabelOverrides(input, key)
const error = (input: unknown, key = "CLASSIC") => {
  const r = run(input, key)
  return r.ok ? null : r.error
}

describe("validateLabelOverrides accepts", () => {
  it.each([
    [{ objective: { singular: "Goal" } }],
    [{ objective: { singular: "Goal", plural: "Goals" } }],
    [{ keyResult: { singular: "Success metric" } }],
    [{ keyResult: { singular: "R&D signal" } }],
    [{ objective: { singular: "Bet/Option" } }],
    [{ objective: { singular: "Quarter’s aim" } }],
    [{ objective: { singular: "Objectif été" } }],
    [{ objective: { singular: "目标" } }],
    [{ objective: { singular: "Café" } }],
    [{ objective: { singular: "हिन्दी" } }],
    [{ objective: { singular: "Go\nal" } }], // a newline collapses to a space
    [{ opportunity: { singular: "Problem", plural: "Problems" } }],
    [{ solution: { singular: "Bet" } }],
    [{ cycle: { singular: "Sprint", plural: "Sprints" } }],
    [{ cycle: { singular: "Quarter" }, solution: { singular: "Idea" }, opportunity: { singular: "Need" } }],
    [{}],
  ])("%j", (input) => {
    expect(run(input).ok).toBe(true)
  })

  it("every entity is overridable, and OVERRIDABLE_ENTITIES is the single allowed set", () => {
    expect([...OVERRIDABLE_ENTITIES].sort()).toEqual([...THINKING_MODEL_ENTITIES].sort())
    for (const entity of OVERRIDABLE_ENTITIES) expect(run({ [entity]: { singular: "Zork" } }).ok).toBe(true)
  })

  it("all five at once, each with a plural, round-trips normalized", () => {
    const input = Object.fromEntries(OVERRIDABLE_ENTITIES.map((e, i) => [e, { singular: ` Name${i}  x `, plural: "Names" + i }]))
    const r = run(input)
    expect(r.ok).toBe(true)
    if (r.ok) for (const [i, e] of OVERRIDABLE_ENTITIES.entries()) expect(r.value[e]).toEqual({ singular: `Name${i} x`, plural: "Names" + i })
  })

  it("trims, collapses whitespace and NFC-normalizes", () => {
    const r = run({ objective: { singular: "  Góal \t  x  " } })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.objective?.singular).toBe("Góal x".normalize("NFC"))
  })
})

describe("validateLabelOverrides rejects", () => {
  const bad: Array<[string, unknown]> = [
    ["html", { objective: { singular: "<b>Goal</b>" } }],
    ["angle bracket", { objective: { singular: "a>b" } }],
    ["double quote", { objective: { singular: 'Go"al' } }],
    ["backtick", { objective: { singular: "Go`al" } }],
    ["control", { objective: { singular: "Go\u0007al" } }],
    ["rtl override", { objective: { singular: "Go‮al" } }],
    ["bidi isolate", { objective: { singular: "Go⁦al" } }],
    ["zero width", { objective: { singular: "Go​al" } }],
    ["empty", { objective: { singular: "   " } }],
    ["leading punctuation", { objective: { singular: "-Goal" } }],
    ["leading combining mark", { objective: { singular: "́Goal" } }],
    ["over length", { objective: { singular: "x".repeat(MAX_LABEL_LENGTH + 1) } }],
    ["over length plural", { objective: { singular: "Goal", plural: "x".repeat(MAX_LABEL_LENGTH + 1) } }],
    ["unknown key", { outcome: { singular: "Goal" } }],
    ["unknown inner key", { objective: { singular: "Goal", lower: "x" } }],
    ["not an object", "x"],
    ["array", []],
    ["non-string", { objective: { singular: 5 } }],
    ["nav collision", { objective: { singular: "Roadmap" } }],
    ["nav collision plural", { objective: { singular: "Goal", plural: "Docs" } }],
    ["nav collision case-insensitive", { objective: { singular: "dIsCoVeRy" } }],
    ["nav collision, full-width", { objective: { singular: "ＲＯＡＤＭＡＰ" } }],
    ["cross-entity duplicate", { objective: { singular: "Thing" }, keyResult: { singular: "thing" } }],
    ["cross-entity duplicate, full-width", { objective: { singular: "Thing" }, keyResult: { singular: "Ｔｈｉｎｇ" } }],
    ["collides with an unchanged entity label", { objective: { singular: "Opportunity" } }],
    ["collides with an unchanged plural", { objective: { singular: "Goal", plural: "Solutions" } }],
  ]
  it.each(bad)("%s", (_n, input) => {
    expect(run(input).ok).toBe(false)
  })

  it("an unknown entity key is a shape error", () => {
    expect(error({ roadmapItem: { singular: "Thing" } })).toMatch(/Labels must be an object keyed by entity/)
  })

  it.each([
    ["opportunity", { opportunity: { singular: "Cycle" } }],
    ["solution", { solution: { singular: "Objective" } }],
    ["cycle", { cycle: { singular: "Key Result" } }],
    ["cycle against another entity's plural", { cycle: { singular: "Key Results" } }],
    ["opportunity against the unchanged Solution", { opportunity: { singular: "solution" } }],
    ["opportunity, full-width", { opportunity: { singular: "ＳＯＬＵＴＩＯＮ" } }],
  ])("collides with an unchanged entity: %s", (_n, input) => {
    expect(error(input)).toMatch(/would name both/)
  })

  it("renaming Solution to Opportunity is fine only when Opportunity is renamed away in the same save", () => {
    expect(run({ solution: { singular: "Opportunity" } }).ok).toBe(false)
    expect(run({ solution: { singular: "Opportunity" }, opportunity: { singular: "Problem" } }).ok).toBe(true)
  })

  it("swapping two entity names in one save is rejected only if they still overlap after the swap", () => {
    expect(run({ solution: { singular: "Opportunity", plural: "Opportunities" }, opportunity: { singular: "Solution", plural: "Solutions" } }).ok).toBe(true)
  })

  it("duplicate across the new entities", () => {
    expect(error({ cycle: { singular: "Sprint" }, solution: { singular: "sprint" } })).toMatch(/would name both/)
    expect(error({ cycle: { singular: "Sprint", plural: "Sprints" }, opportunity: { singular: "Need", plural: "ｓｐｒｉｎｔｓ" } })).toMatch(/would name both/)
  })

  it.each(["opportunity", "solution", "cycle"])("%s: reserved navigation names are rejected, NFKC-folded", (entity) => {
    expect(run({ [entity]: { singular: "Roadmap" } }).ok).toBe(false)
    expect(run({ [entity]: { singular: "ＤＩＳＣＯＶＥＲＹ" } }).ok).toBe(false)
    expect(run({ [entity]: { singular: "Thing", plural: "Docs" } }).ok).toBe(false)
    expect(run({ [entity]: { singular: "okrs" } }).ok).toBe(false)
  })

  it("a derived plural is checked too (a singular whose naive plural collides with a section)", () => {
    // "Canva" + "s" = "Canvas", a nav section.
    expect(error({ cycle: { singular: "Canva" } })).toMatch(/name of a section/)
  })

  it("rejects an unknown inner key and a non-string plural on the new entities", () => {
    expect(run({ cycle: { singular: "Sprint", lower: "x" } }).ok).toBe(false)
    expect(run({ solution: { singular: "Bet", plural: 4 } }).ok).toBe(false)
    expect(run({ opportunity: { singular: "" } }).ok).toBe(false)
  })

  it("the payload size cap is reachable with five entities, and enforced", () => {
    const cjk = (n: number) => "字".repeat(31) + String.fromCharCode(0x4e00 + n)
    const all = OVERRIDABLE_ENTITIES.map((e, i) => [e, { singular: cjk(i * 2), plural: cjk(i * 2 + 1) }] as const)
    const r = run(Object.fromEntries(all))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/too long in total/)
    // Four entities of the same size still fit.
    const four = run(Object.fromEntries(all.slice(0, 4)))
    expect(four.ok).toBe(true)
    if (four.ok) expect(new TextEncoder().encode(JSON.stringify(four.value)).length).toBeLessThanOrEqual(MAX_OVERRIDES_BYTES)
  })

  it("collision check is preset-aware (Torres already owns 'Outcome')", () => {
    expect(run({ keyResult: { singular: "Outcome" } }, "TORRES_OST").ok).toBe(false)
    expect(run({ keyResult: { singular: "Outcome" } }, "CLASSIC").ok).toBe(true)
  })

  it("error wording names the allowed characters plainly", () => {
    expect(error({ objective: { singular: "a>b" } })).toBe(
      "The Objective label may only use letters, numbers, spaces and the characters ' ’ & / - and must start with a letter or number.",
    )
  })

  describe("canonical nouns that are not nav sections are reserved too", () => {
    it.each(["Experiment", "Assumption", "Evidence", "Squad", "Task", "Roadmap item", "Artifact", "Comment", "Agent", "Scoring model"])(
      "%s cannot name any entity, singular or as the plural",
      (noun) => {
        for (const entity of OVERRIDABLE_ENTITIES) {
          expect(error({ [entity]: { singular: noun } }), `${entity} singular ${noun}`).toMatch(/already the name of/)
          expect(error({ [entity]: { singular: "Thing", plural: noun } }), `${entity} plural ${noun}`).toMatch(/already the name of/)
        }
      },
    )

    it("a singular that passes today only because the admin supplied a plural is still refused", () => {
      expect(run({ solution: { singular: "Assumption", plural: "Bets" } }).ok).toBe(false)
      expect(run({ solution: { singular: "Experiments", plural: "Bets" } }).ok).toBe(false)
    })

    it("folds full-width and case variants", () => {
      expect(run({ solution: { singular: "ＥＸＰＥＲＩＭＥＮＴ" } }).ok).toBe(false)
      expect(run({ solution: { singular: "eViDeNcE" } }).ok).toBe(false)
    })

    it("every reserved noun is refused as a plural", () => {
      for (const noun of RESERVED_NOUN_NAMES) expect(run({ solution: { singular: "Thing", plural: noun } }).ok, noun).toBe(false)
    })

    it("ordinary names still pass", () => {
      expect(run({ solution: { singular: "Bet" }, opportunity: { singular: "Problem" }, cycle: { singular: "Sprint" } }).ok).toBe(true)
    })
  })
})
