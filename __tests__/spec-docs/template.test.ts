/** The Spec / Discovery Plan templates: pure, deterministic, and written with the slice-1 embed syntax. */
import { describe, expect, it } from "vitest"
import { parseDocEmbeds } from "@/lib/doc-embeds"
import { renderSpecTemplate, specDocTitle, specTemplateId, type SpecTemplateData } from "@/lib/spec-docs/template"

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const rec = (n: number, title: string) => ({ id: id(n), title })

const solutionData: SpecTemplateData = {
  scopeType: "SOLUTION",
  solution: rec(1, "Checkout [v2]"),
  keyResults: [rec(2, "Lift conversion")],
  assumptions: [rec(3, "Users want it"), rec(4, "It is cheap")],
  experiments: [rec(5, "Fake door")],
  artifacts: [rec(6, "Prototype")],
}
const opportunityData: SpecTemplateData = {
  scopeType: "OPPORTUNITY",
  opportunity: rec(10, "Cart abandonment"),
  keyResults: [rec(11, "Reduce abandonment")],
  objectives: [rec(12, "Grow revenue")],
  solutions: [rec(13, "Checkout redesign")],
  assumptions: [rec(14, "Riskiest")],
  experiments: [rec(15, "Interview")],
  artifacts: [rec(16, "Mock")],
}

const headings = (md: string) => md.split("\n").filter((l) => l.startsWith("## "))

describe("renderSpecTemplate", () => {
  it("renders the Spec sections in order with one block embed per record", () => {
    const md = renderSpecTemplate(solutionData)
    expect(headings(md)).toEqual([
      "## Problem and outcome", "## Solution", "## Assumptions", "## Experiments", "## Prototypes", "## Open questions", "## Decision log",
    ])
    const { segments, issues } = parseDocEmbeds(md, { mode: "strict" })
    expect(issues).toEqual([])
    const embeds = segments.flatMap((s) => (s.type === "embed" ? [s] : []))
    expect(embeds.map((e) => `${e.kind}:${e.id}`)).toEqual([
      `keyResult:${id(2)}`, `solution:${id(1)}`, `assumption:${id(3)}`, `assumption:${id(4)}`, `experiment:${id(5)}`, `artifact:${id(6)}`,
    ])
    expect(embeds.every((e) => e.form === "block")).toBe(true)
  })

  it("escapes brackets in cached titles and round-trips through the parser", () => {
    const md = renderSpecTemplate(solutionData)
    expect(md).toContain(`[Checkout \\[v2\\]](compass://solution/${id(1)})`)
    const solution = parseDocEmbeds(md).segments.find((s) => s.type === "embed" && s.kind === "solution")
    expect(solution && solution.type === "embed" && solution.title).toBe("Checkout [v2]")
  })

  it("renders the Discovery Plan sections in order", () => {
    const md = renderSpecTemplate(opportunityData)
    expect(headings(md)).toEqual([
      "## Outcome", "## Opportunity", "## Solutions under consideration", "## Riskiest assumptions", "## Experiment plan", "## Prototypes", "## Open questions",
    ])
    const kinds = parseDocEmbeds(md, { mode: "strict" }).segments.flatMap((s) => (s.type === "embed" ? [s.kind] : []))
    expect(kinds).toEqual(["keyResult", "objective", "opportunity", "solution", "assumption", "experiment", "artifact"])
  })

  it("is deterministic and an empty scope still yields every heading", () => {
    expect(renderSpecTemplate(solutionData)).toBe(renderSpecTemplate(solutionData))
    const empty = renderSpecTemplate({ ...solutionData, keyResults: [], assumptions: [], experiments: [], artifacts: [] })
    expect(headings(empty)).toHaveLength(7)
    expect(parseDocEmbeds(empty).segments.filter((s) => s.type === "embed")).toHaveLength(1) // only the solution itself
  })

  it("the blank variant has the same headings and no embeds", () => {
    const md = renderSpecTemplate(opportunityData, "blank")
    expect(headings(md)).toEqual(headings(renderSpecTemplate(opportunityData)))
    expect(md).not.toContain("compass://")
  })

  it("names its template version per scope", () => {
    expect(specTemplateId("SOLUTION")).toBe("spec@1")
    expect(specTemplateId("OPPORTUNITY")).toBe("discovery-plan@1")
  })
})

describe("specDocTitle", () => {
  it("prefixes by scope and appends the label", () => {
    expect(specDocTitle("SOLUTION", "Checkout")).toBe("Spec - Checkout")
    expect(specDocTitle("OPPORTUNITY", "Abandonment", "v2")).toBe("Discovery Plan - Abandonment (v2)")
  })
  it("never exceeds the column width and keeps the label when it shortens the scope title", () => {
    const title = specDocTitle("SOLUTION", "x".repeat(400), "keep")
    expect(Array.from(title).length).toBe(255)
    expect(title.endsWith(" (keep)")).toBe(true)
  })
  it("collapses newlines in the scope title", () => {
    expect(specDocTitle("SOLUTION", "a\nb")).toBe("Spec - a b")
  })
})
