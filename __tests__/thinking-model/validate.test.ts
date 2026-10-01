import { describe, expect, it } from "vitest"
import { validateLabelOverrides, MAX_LABEL_LENGTH } from "@/lib/thinking-model/validate"

const run = (input: unknown, key = "CLASSIC") => validateLabelOverrides(input, key)

describe("validateLabelOverrides accepts", () => {
  it.each([
    [{ objective: { singular: "Goal" } }],
    [{ objective: { singular: "Goal", plural: "Goals" } }],
    [{ keyResult: { singular: "Success metric" } }],
    [{ opportunity: { singular: "R&D need" } }],
    [{ solution: { singular: "Bet/Option" } }],
    [{ cycle: { singular: "Quarter’s plan" } }],
    [{ objective: { singular: "Objectif été" } }],
    [{ objective: { singular: "目标" } }],
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
    ["cross-entity duplicate", { objective: { singular: "Thing" }, solution: { singular: "thing" } }],
    ["collides with unchanged entity label", { objective: { singular: "Opportunity" } }],
    ["collides with unchanged plural", { objective: { singular: "Goal", plural: "Solutions" } }],
  ]
  it.each(bad)("%s", (_n, input) => {
    expect(run(input).ok).toBe(false)
  })

  it("rejects a payload over 1 KB even if each label is individually valid", () => {
    // 32 CJK characters is 96 UTF-8 bytes; ten of them cannot fit in 1 KB with JSON overhead.
    const cjk = (n: number) => "字".repeat(31) + String.fromCharCode(0x4e00 + n)
    const r = run({
      opportunity: { singular: cjk(1), plural: cjk(2) },
      objective: { singular: cjk(3), plural: cjk(4) },
      keyResult: { singular: cjk(5), plural: cjk(6) },
      solution: { singular: cjk(7), plural: cjk(8) },
      cycle: { singular: cjk(9), plural: cjk(10) },
    })
    expect(r.ok).toBe(false)
  })

  it("collision check is preset-aware (Torres already owns 'Outcome')", () => {
    expect(run({ opportunity: { singular: "Outcome" } }, "TORRES_OST").ok).toBe(false)
    expect(run({ opportunity: { singular: "Outcome" } }, "CLASSIC").ok).toBe(true)
  })

  it("allows taking another entity's default label when that entity is also renamed", () => {
    expect(run({ objective: { singular: "Solution" }, solution: { singular: "Bet" } }).ok).toBe(true)
  })
})
