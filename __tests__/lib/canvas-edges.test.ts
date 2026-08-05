import { describe, it, expect } from "vitest";
import { buildCanvasEdges } from "@/lib/canvas/edges";
import type { CanvasOverview } from "@/lib/canvas/data";

function makeOverview(overrides: Partial<CanvasOverview> = {}): CanvasOverview {
  return {
    objectives: [],
    keyResults: [],
    opportunities: [],
    solutions: [],
    assumptions: [],
    experiments: [],
    roadmapItems: [],
    ...overrides,
  };
}

describe("buildCanvasEdges", () => {
  it("returns no edges for an empty overview", () => {
    expect(buildCanvasEdges(makeOverview())).toEqual([]);
  });

  it("builds an Objective -> KeyResult edge", () => {
    const overview = makeOverview({
      objectives: [{ id: "obj-1", title: "Obj", status: "ON_TRACK", squad: null, position: null }],
      keyResults: [
        { id: "kr-1", objectiveId: "obj-1", title: "KR", current: 0, target: 1, unit: null, position: null },
      ],
    });

    const edges = buildCanvasEdges(overview);
    expect(edges).toEqual([{ id: "e-obj-1-kr-1", source: "obj-1", target: "kr-1", dashed: false }]);
  });

  it("builds a parent KeyResult -> supporting Objective hierarchy edge", () => {
    const overview = makeOverview({
      objectives: [
        { id: "annual-obj", title: "Annual", status: "ON_TRACK", squad: null, position: null },
        {
          id: "quarterly-obj",
          title: "Quarterly",
          status: "ON_TRACK",
          squad: null,
          parentKeyResultId: "annual-kr",
          position: null,
        },
      ],
      keyResults: [
        { id: "annual-kr", objectiveId: "annual-obj", title: "Annual KR", current: 0, target: 1, unit: null, position: null },
      ],
    });

    expect(buildCanvasEdges(overview)).toContainEqual({
      id: "e-annual-kr-quarterly-obj",
      source: "annual-kr",
      target: "quarterly-obj",
      dashed: false,
    });
  });

  it("builds a KeyResult -> Opportunity edge when linkedKeyResultId is set", () => {
    const overview = makeOverview({
      keyResults: [
        { id: "kr-1", objectiveId: "obj-1", title: "KR", current: 0, target: 1, unit: null, position: null },
      ],
      opportunities: [
        {
          id: "opp-1",
          title: "Opp",
          status: "EXPLORING",
          squad: null,
          linkedKeyResultId: "kr-1",
          position: null,
        },
      ],
    });

    const edges = buildCanvasEdges(overview);
    expect(edges).toContainEqual({ id: "e-kr-1-opp-1", source: "kr-1", target: "opp-1", dashed: false });
  });

  it("does not build a KeyResult -> Opportunity edge when linkedKeyResultId is null", () => {
    const overview = makeOverview({
      opportunities: [
        { id: "opp-1", title: "Opp", status: "EXPLORING", squad: null, linkedKeyResultId: null, position: null },
      ],
    });

    expect(buildCanvasEdges(overview)).toEqual([]);
  });

  it("builds an Opportunity -> Solution edge", () => {
    const overview = makeOverview({
      opportunities: [
        { id: "opp-1", title: "Opp", status: "EXPLORING", squad: null, linkedKeyResultId: null, position: null },
      ],
      solutions: [
        { id: "sol-1", opportunityId: "opp-1", title: "Sol", status: "IDEA", position: null },
      ],
    });

    expect(buildCanvasEdges(overview)).toEqual([
      { id: "e-opp-1-sol-1", source: "opp-1", target: "sol-1", dashed: false },
    ]);
  });

  it("builds a Solution -> Assumption edge", () => {
    const overview = makeOverview({
      solutions: [{ id: "sol-1", opportunityId: "opp-1", title: "Sol", status: "IDEA", position: null }],
      assumptions: [
        { id: "as-1", solutionId: "sol-1", title: "A", riskLevel: "LOW", status: "UNTESTED", position: null },
      ],
    });

    expect(buildCanvasEdges(overview)).toEqual([
      { id: "e-sol-1-as-1", source: "sol-1", target: "as-1", dashed: false },
    ]);
  });

  it("builds an Assumption -> Experiment edge when assumptionId is set", () => {
    const overview = makeOverview({
      assumptions: [
        { id: "as-1", solutionId: "sol-1", title: "A", riskLevel: "LOW", status: "UNTESTED", position: null },
      ],
      experiments: [
        {
          id: "exp-1",
          assumptionId: "as-1",
          title: "Exp",
          squad: null,
          status: "DESIGNING",
          conclusion: null,
          position: null,
        },
      ],
    });

    expect(buildCanvasEdges(overview)).toEqual([
      { id: "e-as-1-exp-1", source: "as-1", target: "exp-1", dashed: false },
    ]);
  });

  it("produces zero incoming edges for an independent Experiment (no assumptionId)", () => {
    const overview = makeOverview({
      experiments: [
        {
          id: "exp-1",
          assumptionId: null,
          title: "Independent Exp",
          squad: null,
          status: "RUNNING",
          conclusion: null,
          position: null,
        },
      ],
    });

    expect(buildCanvasEdges(overview)).toEqual([]);
  });

  it("RoadmapItem precedence: all four FKs set produces one solid + three dashed edges in solution > experiment > opportunity > keyResult order", () => {
    const overview = makeOverview({
      roadmapItems: [
        {
          id: "item-1",
          title: "Item",
          horizon: "NOW",
          squad: null,
          solutionId: "sol-1",
          keyResultId: "kr-1",
          opportunityId: "opp-1",
          experimentId: "exp-1",
          isBug: false,
          position: null,
        },
      ],
      solutions: [{ id: "sol-1", opportunityId: "opp-x", title: "Sol", status: "IDEA", position: null }],
      experiments: [
        { id: "exp-1", assumptionId: null, title: "Exp", squad: null, status: "DESIGNING", conclusion: null, position: null },
      ],
      opportunities: [
        { id: "opp-1", title: "Opp", status: "EXPLORING", squad: null, linkedKeyResultId: null, position: null },
      ],
      keyResults: [
        { id: "kr-1", objectiveId: "obj-1", title: "KR", current: 0, target: 1, unit: null, position: null },
      ],
    });

    const edges = buildCanvasEdges(overview);
    expect(edges).toEqual([
      { id: "e-sol-1-item-1", source: "sol-1", target: "item-1", dashed: false },
      { id: "e-exp-1-item-1", source: "exp-1", target: "item-1", dashed: true },
      { id: "e-opp-1-item-1", source: "opp-1", target: "item-1", dashed: true },
      { id: "e-kr-1-item-1", source: "kr-1", target: "item-1", dashed: true },
    ]);
  });

  it("RoadmapItem with only opportunityId + keyResultId set: opportunity wins primary (higher precedence)", () => {
    const overview = makeOverview({
      roadmapItems: [
        {
          id: "item-1",
          title: "Item",
          horizon: "NOW",
          squad: null,
          solutionId: null,
          keyResultId: "kr-1",
          opportunityId: "opp-1",
          experimentId: null,
          isBug: false,
          position: null,
        },
      ],
      opportunities: [
        { id: "opp-1", title: "Opp", status: "EXPLORING", squad: null, linkedKeyResultId: null, position: null },
      ],
      keyResults: [
        { id: "kr-1", objectiveId: "obj-1", title: "KR", current: 0, target: 1, unit: null, position: null },
      ],
    });

    expect(buildCanvasEdges(overview)).toEqual([
      { id: "e-opp-1-item-1", source: "opp-1", target: "item-1", dashed: false },
      { id: "e-kr-1-item-1", source: "kr-1", target: "item-1", dashed: true },
    ]);
  });

  it("feedback-only RoadmapItem (no FKs set) produces zero edges — orphan node", () => {
    const overview = makeOverview({
      roadmapItems: [
        {
          id: "item-1",
          title: "Feedback-derived Item",
          horizon: "NOW",
          squad: null,
          solutionId: null,
          keyResultId: null,
          opportunityId: null,
          experimentId: null,
          isBug: true,
          position: null,
        },
      ],
    });

    expect(buildCanvasEdges(overview)).toEqual([]);
  });

  it("RoadmapItem with no parents at all produces zero edges — orphan node", () => {
    const overview = makeOverview({
      roadmapItems: [
        {
          id: "item-1",
          title: "Totally orphaned",
          horizon: "LATER",
          squad: null,
          solutionId: null,
          keyResultId: null,
          opportunityId: null,
          experimentId: null,
          isBug: false,
          position: null,
        },
      ],
    });

    expect(buildCanvasEdges(overview)).toEqual([]);
  });

  it("drops an edge referencing an unknown id instead of throwing", () => {
    const overview = makeOverview({
      keyResults: [
        { id: "kr-1", objectiveId: "obj-does-not-exist", title: "KR", current: 0, target: 1, unit: null, position: null },
      ],
    });

    expect(() => buildCanvasEdges(overview)).not.toThrow();
    expect(buildCanvasEdges(overview)).toEqual([]);
  });

  it("skips an unknown primary-precedence parent and promotes the next known parent to solid", () => {
    const overview = makeOverview({
      roadmapItems: [
        {
          id: "item-1",
          title: "Item",
          horizon: "NOW",
          squad: null,
          // solutionId points at an id never fetched (e.g. a race with a
          // concurrent delete) — the opportunity should still become the
          // solid primary edge, not get skipped/marked dashed.
          solutionId: "sol-unknown",
          keyResultId: null,
          opportunityId: "opp-1",
          experimentId: null,
          isBug: false,
          position: null,
        },
      ],
      opportunities: [
        { id: "opp-1", title: "Opp", status: "EXPLORING", squad: null, linkedKeyResultId: null, position: null },
      ],
    });

    expect(buildCanvasEdges(overview)).toEqual([
      { id: "e-opp-1-item-1", source: "opp-1", target: "item-1", dashed: false },
    ]);
  });
});
