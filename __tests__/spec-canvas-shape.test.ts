import { describe, expect, it } from "vitest"
import {
  buildTraceabilityRail,
  keyResultProgress,
  orderAssumptionsByRisk,
  orderExperimentsByProgress,
  shapeSpecCanvas,
  SPEC_SECTION_IDS,
  type RawArtifact,
  type RawKeyResult,
  type RawSpecCanvas,
} from "@/lib/spec-canvas/shape"
import { resolveThinkingModel } from "@/lib/thinking-model/resolve"

const slugs = { orgSlug: "acme", workspaceSlug: "growth" }
const labels = resolveThinkingModel({}).labels

const kr = (id: string, objectiveId: string, extra: Partial<RawKeyResult> = {}): RawKeyResult => ({
  id, title: `KR ${id}`, current: 5, target: 10, unit: "%", objectiveId, seqPrefix: "KR", seqNumber: 1, ...extra,
})
const artifact = (id: string, extra: Partial<RawArtifact> = {}): RawArtifact => ({
  id, title: `Art ${id}`, description: null, sourceType: "HTML_UPLOAD", kind: null, externalUrl: null, thumbnail: null, ...extra,
})

function raw(overrides: Partial<RawSpecCanvas> = {}): RawSpecCanvas {
  return {
    opportunity: { id: "opp-1", title: "Scattered work", description: "desc", status: "VALIDATING", customerSegment: null, seqPrefix: "OPP", seqNumber: 4 },
    evidence: [],
    objectives: [{ id: "obj-1", title: "Grow", description: null, status: "ON_TRACK", seqPrefix: "OBJ", seqNumber: 2 }],
    opportunityKeyResult: null,
    solutions: [],
    solutionKeyResults: new Map(),
    solutionArtifacts: new Map(),
    ...overrides,
  }
}

describe("ordering helpers", () => {
  it("orders assumptions riskiest first and keeps input order among equals", () => {
    const sorted = orderAssumptionsByRisk([
      { id: "a", riskLevel: "LOW" }, { id: "b", riskLevel: "HIGH" }, { id: "c", riskLevel: "MEDIUM" }, { id: "d", riskLevel: "HIGH" }, { id: "e", riskLevel: "WEIRD" },
    ])
    expect(sorted.map((a) => a.id)).toEqual(["b", "d", "c", "a", "e"])
  })

  it("orders experiments by in-flight work first", () => {
    const sorted = orderExperimentsByProgress([
      { id: "1", status: "KILLED" }, { id: "2", status: "COMPLETE" }, { id: "3", status: "RUNNING" }, { id: "4", status: "DESIGNING" }, { id: "5", status: "NOT_PURSUED" },
    ])
    expect(sorted.map((e) => e.id)).toEqual(["3", "4", "2", "1", "5"])
  })

  it("computes bounded key result progress", () => {
    expect(keyResultProgress(5, 10)).toBe(0.5)
    expect(keyResultProgress(15, 10)).toBe(1)
    expect(keyResultProgress(-1, 10)).toBe(0)
    expect(keyResultProgress(1, 0)).toBeNull()
    expect(keyResultProgress(Number.NaN, 10)).toBeNull()
  })
})

describe("shapeSpecCanvas", () => {
  it("builds display-ID links and tones for the opportunity", () => {
    const spec = shapeSpecCanvas(raw(), slugs)
    expect(spec.opportunity.displayId).toBe("OPP-4")
    expect(spec.opportunity.href).toBe("/acme/growth/discovery/OPP-4")
    expect(spec.opportunity.statusTone).toBe("warning")
  })

  it("merges a Key Result linked through the opportunity and several solutions into one entry under its objective", () => {
    const shared = kr("kr-1", "obj-1")
    const spec = shapeSpecCanvas(raw({
      opportunityKeyResult: shared,
      solutions: [
        { id: "s1", title: "Sol A", description: null, status: "IDEA", assumptions: [] },
        { id: "s2", title: "Sol B", description: null, status: "IDEA", assumptions: [] },
      ],
      solutionKeyResults: new Map([["s1", [shared]], ["s2", [shared, kr("kr-2", "obj-1")]]]),
    }), slugs)
    const [objective] = spec.objectives
    expect(objective.keyResults.map((k) => k.id)).toEqual(["kr-1", "kr-2"])
    expect(objective.keyResults[0].linkedVia).toEqual({ opportunity: true, solutionTitles: ["Sol A", "Sol B"] })
    expect(objective.keyResults[1].linkedVia).toEqual({ opportunity: false, solutionTitles: ["Sol B"] })
    expect(objective.keyResults[0].progress).toBe(0.5)
  })

  it("flattens assumptions and experiments with their parents, ordered", () => {
    const spec = shapeSpecCanvas(raw({
      solutions: [{
        id: "s1", title: "Sol A", description: null, status: "SHIPPED",
        assumptions: [
          { id: "a1", title: "Low one", description: null, riskLevel: "LOW", status: "UNTESTED", experiments: [] },
          {
            id: "a2", title: "High one", description: null, riskLevel: "HIGH", status: "TESTING",
            experiments: [
              { id: "e1", title: "Done", hypothesis: "h", status: "COMPLETE", conclusion: "PROCEED", conclusionReason: "worked", assumptionId: "a2" },
              { id: "e2", title: "Live", hypothesis: "h", status: "RUNNING", conclusion: null, conclusionReason: null, assumptionId: "a2" },
            ],
          },
        ],
      }],
    }), slugs)
    expect(spec.assumptions.map((a) => a.id)).toEqual(["a2", "a1"])
    expect(spec.assumptions[0]).toMatchObject({ solutionTitle: "Sol A", riskTone: "danger", statusTone: "warning", experimentCount: 2 })
    expect(spec.experiments.map((e) => e.id)).toEqual(["e2", "e1"])
    expect(spec.experiments[1]).toMatchObject({ assumptionTitle: "High one", conclusionTone: "success", conclusionReason: "worked" })
    expect(spec.experiments[0].conclusionTone).toBeNull()
    expect(spec.solutions[0]).toMatchObject({ statusTone: "success", assumptionCount: 2 })
    expect(spec.solutions[0].href).toBe("/acme/growth/discovery/opp-1?detail=solution%3As1")
  })

  it("lists an artifact linked to several solutions once", () => {
    const shared = artifact("art-1", { previewHtml: "<html/>" })
    const spec = shapeSpecCanvas(raw({
      solutions: [
        { id: "s1", title: "Sol A", description: null, status: "IDEA", assumptions: [] },
        { id: "s2", title: "Sol B", description: null, status: "IDEA", assumptions: [] },
      ],
      solutionArtifacts: new Map([["s1", [shared]], ["s2", [shared, artifact("art-2")]]]),
    }), slugs)
    expect(spec.artifacts.map((a) => [a.id, a.solutionTitles])).toEqual([["art-1", ["Sol A", "Sol B"]], ["art-2", ["Sol B"]]])
    expect(spec.artifacts[0].previewHtml).toBe("<html/>")
    expect(spec.artifacts[1].previewHtml).toBeNull()
    expect(spec.solutions.map((s) => s.artifactCount)).toEqual([1, 2])
  })

  it("falls back to neutral for unknown statuses", () => {
    const spec = shapeSpecCanvas(raw({ opportunity: { ...raw().opportunity, status: "SOMETHING_NEW" } }), slugs)
    expect(spec.opportunity.statusTone).toBe("neutral")
  })
})

describe("buildTraceabilityRail", () => {
  it("walks outcome to prototype with counts, keeping empty sections visible", () => {
    const spec = shapeSpecCanvas(raw({ opportunityKeyResult: kr("kr-1", "obj-1") }), slugs)
    const rail = buildTraceabilityRail(spec, labels)
    expect(rail.map((r) => r.key)).toEqual(["outcome", "opportunity", "solutions", "assumptions", "experiments", "prototypes"])
    expect(rail.map((r) => r.anchorId)).toEqual(Object.values(SPEC_SECTION_IDS))
    expect(rail[0]).toMatchObject({ label: `${labels.objective.plural} & ${labels.keyResult.plural}`, count: 2 })
    expect(rail[2]).toMatchObject({ label: labels.solution.plural, count: 0 })
  })

  it("uses the workspace's thinking-model labels", () => {
    const renamed = resolveThinkingModel({
      thinkingModel: "CLASSIC",
      thinkingModelLabels: JSON.stringify({ solution: { singular: "Bet", plural: "Bets" } }),
    }).labels
    const rail = buildTraceabilityRail(shapeSpecCanvas(raw(), slugs), renamed)
    expect(rail.find((r) => r.key === "solutions")?.label).toBe("Bets")
  })
})
