import { describe, expect, it } from "vitest"
import { validateLabelOverrides, MAX_LABEL_LENGTH, MAX_OVERRIDES_BYTES } from "@/lib/thinking-model/validate"

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
    [{}],
  ])("%j", (input) => {
    expect(run(input).ok).toBe(true)
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

  it.each(["opportunity", "solution", "cycle"])("%s: not renamable yet, with a clear message", (entity) => {
    const message = error({ [entity]: { singular: "Thing" } })
    expect(message).toMatch(/is not available yet/)
    expect(message).toMatch(/Only Objective and Key Result can be renamed/)
  })

  it("the payload size cap is a real invariant even though two entities cannot reach it", () => {
    // 2 entities x (singular + plural) x 32 CJK characters (96 bytes) plus JSON overhead stays under the cap.
    const cjk = (n: number) => "字".repeat(31) + String.fromCharCode(0x4e00 + n)
    const r = run({
      objective: { singular: cjk(1), plural: cjk(2) },
      keyResult: { singular: cjk(3), plural: cjk(4) },
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(new TextEncoder().encode(JSON.stringify(r.value)).length).toBeLessThanOrEqual(MAX_OVERRIDES_BYTES)
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
})
