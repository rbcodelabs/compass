import { describe, expect, it } from "vitest"
import { currentValue, specReducer } from "@/lib/spec-canvas/reducer"
import { groupByParent, optionsWithCurrent, RISK_LEVEL_OPTIONS } from "@/lib/spec-canvas/options"
import { buildSpecAssumption, buildSpecExperiment, buildSpecSolution, buildTraceabilityRail, type SpecCanvas } from "@/lib/spec-canvas/shape"
import { resolveThinkingModel } from "@/lib/thinking-model/resolve"

const slugs = { orgSlug: "acme", workspaceSlug: "growth" }
const sol = (id: string, title = `Sol ${id}`) => buildSpecSolution({ id, title, description: null, status: "IDEA" }, slugs, "opp-1")
const asm = (id: string, solutionId: string, title = `Asm ${id}`) =>
  buildSpecAssumption({ id, title, description: null, riskLevel: "LOW", status: "UNTESTED" }, { id: solutionId, title: `Sol ${solutionId}` }, slugs, "opp-1")
const exp = (id: string, assumptionId: string) =>
  buildSpecExperiment({ id, title: `Exp ${id}`, hypothesis: "h", status: "DESIGNING", conclusion: null, conclusionReason: null }, { id: assumptionId, title: `Asm ${assumptionId}` }, slugs)

function base(): SpecCanvas {
  return {
    opportunity: { id: "opp-1", displayId: "OPP-4", title: "Opp", description: null, status: "EXPLORING", statusTone: "info", customerSegment: null, href: "/x" },
    evidence: [],
    objectives: [],
    solutions: [sol("s1"), sol("s2")],
    assumptions: [asm("a1", "s1"), asm("a2", "s2")],
    experiments: [exp("e1", "a1")],
    artifacts: [{ id: "art", displayId: null, title: "Art", description: null, href: "/a", sourceType: "HTML_UPLOAD", kind: null, externalUrl: null, thumbnail: null, previewHtml: null, solutionTitles: ["Sol s1"] }],
  }
}
const labels = resolveThinkingModel({}).labels

describe("specReducer patch", () => {
  it("updates the opportunity and recomputes the status tone", () => {
    const next = specReducer(base(), { type: "patch", entity: "opportunity", id: "opp-1", field: "status", value: "ACTIVE" })
    expect(next.opportunity).toMatchObject({ status: "ACTIVE", statusTone: "success" })
    expect(specReducer(next, { type: "patch", entity: "opportunity", id: "opp-1", field: "description", value: "hello" }).opportunity.description).toBe("hello")
  })
  it("propagates a solution rename to assumptions and artifacts", () => {
    const next = specReducer(base(), { type: "patch", entity: "solution", id: "s1", field: "title", value: "Renamed" })
    expect(next.assumptions[0].solutionTitle).toBe("Renamed")
    expect(next.assumptions[1].solutionTitle).toBe("Sol s2")
    expect(next.artifacts[0].solutionTitles).toEqual(["Renamed"])
  })
  it("propagates an assumption rename to its experiments and keeps the order", () => {
    const next = specReducer(base(), { type: "patch", entity: "assumption", id: "a1", field: "title", value: "New" })
    expect(next.experiments[0].assumptionTitle).toBe("New")
    expect(next.assumptions.map((a) => a.id)).toEqual(["a1", "a2"])
  })
  it("changes risk level and tone without re-sorting", () => {
    const next = specReducer(base(), { type: "patch", entity: "assumption", id: "a2", field: "riskLevel", value: "HIGH" })
    expect(next.assumptions.map((a) => [a.id, a.riskLevel, a.riskTone])).toEqual([["a1", "LOW", "success"], ["a2", "HIGH", "danger"]])
  })
  it("changes experiment status and hypothesis", () => {
    let next = specReducer(base(), { type: "patch", entity: "experiment", id: "e1", field: "status", value: "RUNNING" })
    next = specReducer(next, { type: "patch", entity: "experiment", id: "e1", field: "hypothesis", value: "new h" })
    expect(next.experiments[0]).toMatchObject({ status: "RUNNING", statusTone: "info", hypothesis: "new h" })
  })
  it("ignores unknown ids and fields", () => {
    const state = base()
    expect(specReducer(state, { type: "patch", entity: "solution", id: "nope", field: "title", value: "x" })).toBe(state)
    expect(specReducer(state, { type: "patch", entity: "solution", id: "s1", field: "riskLevel", value: "HIGH" })).toBe(state)
  })
  it("reads the current value so a failed save can restore it", () => {
    const state = base()
    expect(currentValue(state, "assumption", "a1", "riskLevel")).toBe("LOW")
    expect(currentValue(state, "opportunity", "opp-1", "title")).toBe("Opp")
    expect(currentValue(state, "solution", "gone", "title")).toBeUndefined()
  })
})

describe("specReducer creation", () => {
  it("adds a solution at the end", () => {
    expect(specReducer(base(), { type: "addSolution", solution: sol("s3") }).solutions.map((s) => s.id)).toEqual(["s1", "s2", "s3"])
  })
  it("inserts an assumption after its solution's last one and updates counts", () => {
    const next = specReducer(base(), { type: "addAssumption", assumption: asm("a3", "s1") })
    expect(next.assumptions.map((a) => a.id)).toEqual(["a1", "a3", "a2"])
    expect(next.solutions.map((s) => s.assumptionCount)).toEqual([2, 1])
  })
  it("inserts an experiment under its assumption and updates counts", () => {
    const next = specReducer(base(), { type: "addExperiment", experiment: exp("e2", "a1") })
    expect(next.experiments.map((e) => e.id)).toEqual(["e1", "e2"])
    expect(next.assumptions.map((a) => a.experimentCount)).toEqual([2, 0])
  })
  it("ignores a duplicate create (double submit)", () => {
    const state = base()
    expect(specReducer(state, { type: "addSolution", solution: sol("s1") })).toBe(state)
  })
  it("keeps the traceability rail counts live", () => {
    const rail = buildTraceabilityRail(specReducer(base(), { type: "addSolution", solution: sol("s3") }), labels)
    expect(rail.find((r) => r.key === "solutions")?.count).toBe(3)
  })
})

describe("options helpers", () => {
  it("groups children under every parent, including empty ones", () => {
    const groups = groupByParent([{ id: "p1" }, { id: "p2" }], [{ p: "p2", n: 1 }, { p: "p2", n: 2 }], (i) => i.p)
    expect(groups.map((g) => [g.parent.id, g.items.length])).toEqual([["p1", 0], ["p2", 2]])
  })
  it("keeps an unselectable current value visible", () => {
    expect(optionsWithCurrent(RISK_LEVEL_OPTIONS, "HIGH")).toHaveLength(3)
    expect(optionsWithCurrent(RISK_LEVEL_OPTIONS, "NOT_PURSUED")[0]).toEqual({ value: "NOT_PURSUED", label: "Not pursued" })
  })
})
