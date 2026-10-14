import { describe, expect, it } from "vitest";
import { buildCanvasEdges } from "@/lib/canvas/edges";
import type { CanvasOverview } from "@/lib/canvas/data";
import { THINKING_MODEL_PRESETS } from "@/lib/thinking-model/presets";

/**
 * Typed-link edges (ADR Phase 4B): Objective -> Opportunity and Solution -> Key Result. The data is the same for every preset;
 * only which links are drawn differs (CLASSIC: user-made DIRECT links only; the other presets: every link, with a LEGACY link
 * that merely restates the Opportunity -> Key Result edge skipped so one relationship never draws two lines).
 */
const CLASSIC = { links: THINKING_MODEL_PRESETS.CLASSIC.links };
const TORRES = { links: THINKING_MODEL_PRESETS.TORRES_OST.links };
const OFO = { links: THINKING_MODEL_PRESETS.OPPORTUNITY_FIRST_OKR.links };

const node = { squad: null, position: null } as const;

function overview(overrides: Partial<CanvasOverview> = {}): CanvasOverview {
  return {
    objectives: [
      { id: "obj-1", title: "O1", status: "ON_TRACK", ...node },
      { id: "obj-2", title: "O2", status: "ON_TRACK", ...node },
    ],
    keyResults: [
      { id: "kr-1", objectiveId: "obj-1", title: "KR1", current: 0, target: 1, unit: null, position: null },
      { id: "kr-2", objectiveId: "obj-2", title: "KR2", current: 0, target: 1, unit: null, position: null },
    ],
    opportunities: [{ id: "opp-1", title: "Opp", status: "EXPLORING", linkedKeyResultId: null, ...node }],
    solutions: [{ id: "sol-1", opportunityId: "opp-1", title: "Sol", status: "IDEA", position: null }],
    assumptions: [],
    experiments: [],
    roadmapItems: [],
    ...overrides,
  };
}

const linkEdges = (edges: ReturnType<typeof buildCanvasEdges>) => edges.filter((e) => e.link);

describe("buildCanvasEdges: typed-link edges", () => {
  it("draws no link edge when the overview carries no links (tolerant read, or an older payload)", () => {
    expect(linkEdges(buildCanvasEdges(overview(), TORRES))).toEqual([]);
    expect(linkEdges(buildCanvasEdges(overview({ links: { opportunityObjective: [], solutionKeyResult: [] } }), TORRES))).toEqual([]);
  });

  it("draws Objective -> Opportunity and Solution -> Key Result as dashed link edges under TORRES_OST and OPPORTUNITY_FIRST_OKR", () => {
    const o = overview({
      links: {
        opportunityObjective: [{ opportunityId: "opp-1", objectiveId: "obj-2", origin: "DIRECT" }],
        solutionKeyResult: [{ solutionId: "sol-1", keyResultId: "kr-2" }],
      },
    });
    for (const options of [TORRES, OFO]) {
      expect(linkEdges(buildCanvasEdges(o, options))).toEqual([
        { id: "l-obj-2-opp-1", source: "obj-2", target: "opp-1", dashed: true, link: true },
        { id: "l-sol-1-kr-2", source: "sol-1", target: "kr-2", dashed: true, link: true },
      ]);
    }
  });

  it("draws every LEGACY link under the other presets, but not one that restates the Opportunity -> Key Result edge", () => {
    const o = overview({
      opportunities: [{ id: "opp-1", title: "Opp", status: "EXPLORING", linkedKeyResultId: "kr-1", ...node }],
      links: {
        opportunityObjective: [
          // kr-1 belongs to obj-1: Objective -> KR -> Opportunity already draws this relationship.
          { opportunityId: "opp-1", objectiveId: "obj-1", origin: "LEGACY" },
          // A LEGACY link to some other objective (drifted pointer) is still drawn.
          { opportunityId: "opp-1", objectiveId: "obj-2", origin: "LEGACY" },
        ],
        solutionKeyResult: [],
      },
    });
    const edges = buildCanvasEdges(o, TORRES);
    expect(linkEdges(edges).map((e) => e.id)).toEqual(["l-obj-2-opp-1"]);
    // One relationship, one line: the existing KR -> Opportunity edge is unchanged and the duplicate is absent.
    expect(edges).toContainEqual({ id: "e-kr-1-opp-1", source: "kr-1", target: "opp-1", dashed: false });
    expect(edges.filter((e) => e.target === "opp-1" && (e.source === "obj-1" || e.source === "kr-1"))).toHaveLength(1);
  });

  it("still draws a DIRECT link to the pointer's own objective (a deliberate claim, not a restatement)", () => {
    const o = overview({
      opportunities: [{ id: "opp-1", title: "Opp", status: "EXPLORING", linkedKeyResultId: "kr-1", ...node }],
      links: { opportunityObjective: [{ opportunityId: "opp-1", objectiveId: "obj-1", origin: "DIRECT" }], solutionKeyResult: [] },
    });
    expect(linkEdges(buildCanvasEdges(o, TORRES)).map((e) => e.id)).toEqual(["l-obj-1-opp-1"]);
  });

  it("CLASSIC draws only DIRECT links: backfilled LEGACY links never change a CLASSIC canvas", () => {
    const o = overview({
      opportunities: [{ id: "opp-1", title: "Opp", status: "EXPLORING", linkedKeyResultId: "kr-1", ...node }],
      links: {
        opportunityObjective: [
          { opportunityId: "opp-1", objectiveId: "obj-1", origin: "LEGACY" },
          { opportunityId: "opp-1", objectiveId: "obj-2", origin: "LEGACY" },
        ],
        solutionKeyResult: [],
      },
    });
    // Byte-identical to a canvas with no links at all.
    expect(buildCanvasEdges(o, CLASSIC)).toEqual(buildCanvasEdges(overview({ opportunities: o.opportunities }), CLASSIC));
    expect(buildCanvasEdges(o)).toEqual(buildCanvasEdges(overview({ opportunities: o.opportunities })));
  });

  it("CLASSIC draws the links someone made on purpose", () => {
    const o = overview({
      links: {
        opportunityObjective: [{ opportunityId: "opp-1", objectiveId: "obj-2", origin: "DIRECT" }],
        solutionKeyResult: [{ solutionId: "sol-1", keyResultId: "kr-1" }],
      },
    });
    expect(linkEdges(buildCanvasEdges(o, CLASSIC)).map((e) => e.id)).toEqual(["l-obj-2-opp-1", "l-sol-1-kr-1"]);
  });

  it("drops a link whose endpoint is not a node (hidden / foreign / NULL-workspace rows are never loaded as nodes)", () => {
    const o = overview({
      links: {
        opportunityObjective: [
          { opportunityId: "opp-1", objectiveId: "obj-foreign", origin: "DIRECT" },
          { opportunityId: "opp-gone", objectiveId: "obj-1", origin: "DIRECT" },
        ],
        solutionKeyResult: [
          { solutionId: "sol-1", keyResultId: "kr-null" },
          { solutionId: "sol-gone", keyResultId: "kr-1" },
        ],
      },
    });
    expect(linkEdges(buildCanvasEdges(o, TORRES))).toEqual([]);
  });

  it("never duplicates a link edge and leaves every existing edge exactly as it was", () => {
    const base = overview({
      opportunities: [{ id: "opp-1", title: "Opp", status: "EXPLORING", linkedKeyResultId: "kr-1", ...node }],
    });
    const withLinks = overview({
      opportunities: base.opportunities,
      links: {
        opportunityObjective: [
          { opportunityId: "opp-1", objectiveId: "obj-2", origin: "DIRECT" },
          { opportunityId: "opp-1", objectiveId: "obj-2", origin: "DIRECT" },
        ],
        solutionKeyResult: [{ solutionId: "sol-1", keyResultId: "kr-2" }],
      },
    });
    const edges = buildCanvasEdges(withLinks, TORRES);
    expect(edges.filter((e) => !e.link)).toEqual(buildCanvasEdges(base, TORRES));
    expect(linkEdges(edges)).toHaveLength(2);
  });
});
