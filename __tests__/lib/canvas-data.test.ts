import { describe, it, expect, vi } from "vitest";
import type { AppPrismaClient } from "@/lib/db";
import { getCanvasOverview } from "@/lib/canvas/data";

/**
 * getCanvasOverview takes its AppPrismaClient as an explicit argument (not via
 * getPrisma()), so — unlike the vi.mock("@/lib/db") pattern used for server
 * actions — a fake client object can just be passed in directly.
 */
function makeFakePrisma(overrides: {
  squads?: unknown[];
  objectives?: unknown[];
  keyResults?: unknown[];
  opportunities?: unknown[];
  solutions?: unknown[];
  assumptions?: unknown[];
  experiments?: unknown[];
  roadmapItems?: unknown[];
  positions?: unknown[];
  opportunityLinks?: unknown[];
  solutionLinks?: unknown[];
}): AppPrismaClient {
  return {
    opportunityObjectiveLink: {
      findMany: vi.fn().mockResolvedValue(overrides.opportunityLinks ?? []),
    },
    solutionKeyResultLink: {
      findMany: vi.fn().mockResolvedValue(overrides.solutionLinks ?? []),
    },
    squad: {
      findMany: vi.fn().mockResolvedValue(overrides.squads ?? []),
    },
    objective: {
      findMany: vi.fn().mockResolvedValue(overrides.objectives ?? []),
    },
    keyResult: {
      findMany: vi.fn().mockResolvedValue(overrides.keyResults ?? []),
    },
    opportunity: {
      findMany: vi.fn().mockResolvedValue(overrides.opportunities ?? []),
    },
    solution: {
      findMany: vi.fn().mockResolvedValue(overrides.solutions ?? []),
    },
    assumption: {
      findMany: vi.fn().mockResolvedValue(overrides.assumptions ?? []),
    },
    experiment: {
      findMany: vi.fn().mockResolvedValue(overrides.experiments ?? []),
    },
    roadmapItem: {
      findMany: vi.fn().mockResolvedValue(overrides.roadmapItems ?? []),
    },
    canvasNodePosition: {
      findMany: vi.fn().mockResolvedValue(overrides.positions ?? []),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

const EMPTY_OVERVIEW = {
  objectives: [],
  keyResults: [],
  opportunities: [],
  solutions: [],
  assumptions: [],
  experiments: [],
  roadmapItems: [],
  links: { opportunityObjective: [], solutionKeyResult: [] },
};

describe("getCanvasOverview", () => {
  it("returns an empty overview for a workspace with no data", async () => {
    const prisma = makeFakePrisma({});
    const result = await getCanvasOverview(prisma, "ws-1");
    expect(result).toEqual(EMPTY_OVERVIEW);
  });

  it("does not query key results, assumptions, or positions when there are no objectives/solutions", async () => {
    const prisma = makeFakePrisma({});
    await getCanvasOverview(prisma, "ws-1");
    expect(prisma.keyResult.findMany).not.toHaveBeenCalled();
    expect(prisma.assumption.findMany).not.toHaveBeenCalled();
    expect(prisma.canvasNodePosition.findMany).not.toHaveBeenCalled();
  });

  it("scopes the objective query to the workspace across all cycles", async () => {
    const prisma = makeFakePrisma({});
    await getCanvasOverview(prisma, "ws-1");
    expect(prisma.objective.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId: "ws-1" },
      })
    );
  });

  it("joins key results onto their objective", async () => {
    const prisma = makeFakePrisma({
      objectives: [
        { id: "obj-1", title: "Grow revenue", status: "ON_TRACK", squadId: null },
      ],
      keyResults: [
        { id: "kr-1", objectiveId: "obj-1", title: "Hit $1M ARR", current: 50, target: 100, unit: "%" },
        { id: "kr-2", objectiveId: "obj-1", title: "Sign 10 logos", current: 3, target: 10, unit: null },
      ],
    });

    const result = await getCanvasOverview(prisma, "ws-1");

    expect(result.keyResults).toEqual([
      { id: "kr-1", objectiveId: "obj-1", title: "Hit $1M ARR", current: 50, target: 100, unit: "%", position: null },
      { id: "kr-2", objectiveId: "obj-1", title: "Sign 10 logos", current: 3, target: 10, unit: null, position: null },
    ]);
  });

  it("attaches squad data by squadId across objectives, opportunities, and experiments", async () => {
    const prisma = makeFakePrisma({
      squads: [{ id: "sq-1", name: "Growth", color: "#6366f1" }],
      objectives: [
        { id: "obj-1", title: "With squad", status: "ON_TRACK", squadId: "sq-1" },
        { id: "obj-2", title: "No squad", status: "ON_TRACK", squadId: null },
      ],
      opportunities: [
        { id: "opp-1", title: "Opp", status: "EXPLORING", squadId: "sq-1", linkedKeyResultId: null },
      ],
      experiments: [
        {
          id: "exp-1",
          assumptionId: null,
          title: "Exp",
          squadId: "sq-1",
          status: "DESIGNING",
          conclusion: null,
        },
      ],
    });

    const result = await getCanvasOverview(prisma, "ws-1");

    expect(result.objectives.find((o) => o.id === "obj-1")?.squad).toEqual({
      id: "sq-1",
      name: "Growth",
      color: "#6366f1",
    });
    expect(result.objectives.find((o) => o.id === "obj-2")?.squad).toBeNull();
    expect(result.opportunities[0].squad).toEqual({ id: "sq-1", name: "Growth", color: "#6366f1" });
    expect(result.experiments[0].squad).toEqual({ id: "sq-1", name: "Growth", color: "#6366f1" });
  });

  it("maps opportunities including linkedKeyResultId", async () => {
    const prisma = makeFakePrisma({
      opportunities: [
        { id: "opp-1", title: "Linked", status: "VALIDATING", squadId: null, linkedKeyResultId: "kr-1" },
        { id: "opp-2", title: "Unlinked", status: "EXPLORING", squadId: null, linkedKeyResultId: null },
      ],
    });

    const result = await getCanvasOverview(prisma, "ws-1");

    expect(result.opportunities).toEqual([
      { id: "opp-1", title: "Linked", status: "VALIDATING", squad: null, linkedKeyResultId: "kr-1", linkedObjectives: [], position: null },
      { id: "opp-2", title: "Unlinked", status: "EXPLORING", squad: null, linkedKeyResultId: null, linkedObjectives: [], position: null },
    ]);
  });

  it("adds the typed links as payload only: linkedKeyResultId is untouched and links to a foreign objective are hidden", async () => {
    const prisma = makeFakePrisma({
      objectives: [{ id: "obj-1", title: "Objective one", status: "ON_TRACK", squadId: null, parentKeyResultId: null }],
      opportunities: [{ id: "opp-1", title: "Opp", status: "EXPLORING", squadId: null, linkedKeyResultId: null }],
      solutions: [{ id: "sol-1", opportunityId: "opp-1", title: "Sol", status: "IDEA" }],
      keyResults: [{ id: "kr-1", objectiveId: "obj-1", title: "KR one", current: 0, target: 1, unit: null }],
      opportunityLinks: [
        { id: "l1", opportunityId: "opp-1", objectiveId: "obj-1", createdAt: new Date(1) },
        { id: "l2", opportunityId: "opp-1", objectiveId: "obj-foreign", createdAt: new Date(2) },
      ],
      solutionLinks: [{ id: "s1", solutionId: "sol-1", keyResultId: "kr-1", createdAt: new Date(1) }],
    });
    // The helper's workspace re-checks go through the same fakes: objectives returns obj-1 only, so obj-foreign is dropped.
    const result = await getCanvasOverview(prisma, "ws-1");
    expect(result.opportunities[0]).toMatchObject({ linkedKeyResultId: null, linkedObjectives: [{ id: "obj-1", title: "Objective one" }] });
    expect(result.solutions[0].linkedKeyResults).toEqual([{ id: "kr-1", title: "KR one", objectiveId: "obj-1" }]);
    expect(prisma.opportunityObjectiveLink.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ workspaceId: "ws-1" }) }),
    );
  });

  it("loads link rows for the edge layer: workspace-filtered, ids only, one query per link table", async () => {
    const prisma = makeFakePrisma({
      opportunities: [{ id: "opp-1", title: "Opp", status: "EXPLORING", squadId: null, linkedKeyResultId: null }],
      solutions: [{ id: "sol-1", opportunityId: "opp-1", title: "Sol", status: "IDEA" }],
      opportunityLinks: [{ id: "l1", opportunityId: "opp-1", objectiveId: "obj-1", origin: "DIRECT", createdAt: new Date(1) }],
      solutionLinks: [{ id: "s1", solutionId: "sol-1", keyResultId: "kr-1", createdAt: new Date(1) }],
    });
    const result = await getCanvasOverview(prisma, "ws-1");
    expect(result.links).toEqual({
      opportunityObjective: [{ opportunityId: "opp-1", objectiveId: "obj-1", origin: "DIRECT" }],
      solutionKeyResult: [{ solutionId: "sol-1", keyResultId: "kr-1" }],
    });
    // Two reads per table in total: the existing additive payload plus the edge rows, never one per entity.
    expect(prisma.opportunityObjectiveLink.findMany).toHaveBeenCalledTimes(2);
    expect(prisma.solutionKeyResultLink.findMany).toHaveBeenCalledTimes(2);
    expect(prisma.opportunityObjectiveLink.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { workspaceId: "ws-1", opportunityId: { in: ["opp-1"] } } }),
    );
  });

  it("linkOrigins DIRECT asks the database for user-made Opportunity<->Objective links only", async () => {
    const prisma = makeFakePrisma({
      opportunities: [{ id: "opp-1", title: "Opp", status: "EXPLORING", squadId: null, linkedKeyResultId: null }],
    });
    await getCanvasOverview(prisma, "ws-1", { linkOrigins: "DIRECT" });
    expect(prisma.opportunityObjectiveLink.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { workspaceId: "ws-1", opportunityId: { in: ["opp-1"] }, origin: "DIRECT" } }),
    );
  });

  it("chunks the link reads: 1,001 opportunities are read in three chunks, not one query per row", async () => {
    const opportunities = Array.from({ length: 1001 }, (_, i) => ({ id: `opp-${i}`, title: "O", status: "EXPLORING", squadId: null, linkedKeyResultId: null }));
    const prisma = makeFakePrisma({ opportunities });
    await getCanvasOverview(prisma, "ws-1");
    // 3 chunks for the edge rows + 3 for the additive payload.
    expect(prisma.opportunityObjectiveLink.findMany).toHaveBeenCalledTimes(6);
  });

  it("a missing link table FAILS the loader with the database error: no silent 'no links', no omitted edges", async () => {
    const base = {
      opportunities: [{ id: "opp-1", title: "Opp", status: "EXPLORING", squadId: null, linkedKeyResultId: null }],
      solutions: [{ id: "sol-1", opportunityId: "opp-1", title: "Sol", status: "IDEA" }],
    };
    const missing = Object.assign(new Error('relation "opportunity_objective_links" does not exist'), { code: "42P01" });
    type Reader = ReturnType<typeof vi.fn>;
    // Only the canvas's own edge-row reads (they select `origin` / are the second read) fail, so the loader itself must not swallow it.
    const edgeRowsOnly = (error: unknown, selectKey: string) => (args: { select?: Record<string, unknown> }) =>
      args.select && selectKey in args.select ? Promise.reject(error) : Promise.resolve([]);

    const oppLinks = makeFakePrisma(base);
    (oppLinks.opportunityObjectiveLink.findMany as Reader).mockImplementation(edgeRowsOnly(missing, "origin"));
    await expect(getCanvasOverview(oppLinks, "ws-1")).rejects.toBe(missing);

    const solLinks = makeFakePrisma(base);
    const missingSol = Object.assign(new Error("missing"), { code: "P2021" });
    let calls = 0;
    (solLinks.solutionKeyResultLink.findMany as Reader).mockImplementation(() => (++calls === 2 ? Promise.reject(missingSol) : Promise.resolve([])));
    await expect(getCanvasOverview(solLinks, "ws-1")).rejects.toBe(missingSol);

    // And the additive payload reads fail too, rather than returning empty lists.
    const payload = makeFakePrisma(base);
    (payload.opportunityObjectiveLink.findMany as Reader).mockRejectedValue(missing);
    await expect(getCanvasOverview(payload, "ws-1")).rejects.toBe(missing);
  });

  it("any other link read failure still throws (a permission error or outage is not 'no links')", async () => {
    const prisma = makeFakePrisma({
      opportunities: [{ id: "opp-1", title: "Opp", status: "EXPLORING", squadId: null, linkedKeyResultId: null }],
    });
    (prisma.opportunityObjectiveLink.findMany as ReturnType<typeof vi.fn>).mockRejectedValue(Object.assign(new Error("permission denied"), { code: "42501" }));
    await expect(getCanvasOverview(prisma, "ws-1")).rejects.toThrow("permission denied");
  });

  it("maps solutions scoped by their own workspaceId", async () => {
    const prisma = makeFakePrisma({
      opportunities: [{ id: "opp-1", title: "Opp", status: "EXPLORING", squadId: null, linkedKeyResultId: null }],
      solutions: [{ id: "sol-1", opportunityId: "opp-1", title: "Sol", status: "IDEA" }],
    });

    const result = await getCanvasOverview(prisma, "ws-1");

    expect(prisma.solution.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId: "ws-1" } })
    );
    expect(result.solutions).toEqual([
      { id: "sol-1", opportunityId: "opp-1", title: "Sol", status: "IDEA", linkedKeyResults: [], position: null },
    ]);
  });

  it("maps assumptions scoped to fetched solution ids", async () => {
    const prisma = makeFakePrisma({
      opportunities: [{ id: "opp-1", title: "Opp", status: "EXPLORING", squadId: null, linkedKeyResultId: null }],
      solutions: [{ id: "sol-1", opportunityId: "opp-1", title: "Sol", status: "IDEA" }],
      assumptions: [{ id: "as-1", solutionId: "sol-1", title: "A", riskLevel: "HIGH", status: "TESTING" }],
    });

    const result = await getCanvasOverview(prisma, "ws-1");

    expect(prisma.assumption.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { solutionId: { in: ["sol-1"] } } })
    );
    expect(result.assumptions).toEqual([
      { id: "as-1", solutionId: "sol-1", title: "A", riskLevel: "HIGH", status: "TESTING", position: null },
    ]);
  });

  it("includes independent Experiments (no assumptionId) since they're queried directly by workspaceId", async () => {
    const prisma = makeFakePrisma({
      experiments: [
        { id: "exp-1", assumptionId: null, title: "Independent", squadId: null, status: "RUNNING", conclusion: null },
      ],
    });

    const result = await getCanvasOverview(prisma, "ws-1");

    expect(prisma.experiment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId: "ws-1" } })
    );
    expect(result.experiments).toEqual([
      { id: "exp-1", assumptionId: null, title: "Independent", squad: null, status: "RUNNING", conclusion: null, position: null },
    ]);
  });

  it("derives isBug true when the linked feedback item's type is BUG", async () => {
    const prisma = makeFakePrisma({
      roadmapItems: [
        {
          id: "item-1",
          title: "Bug item",
          horizon: "NOW",
          squadId: null,
          solutionId: null,
          keyResultId: null,
          opportunityId: null,
          experimentId: null,
          feedback: { type: "BUG" },
        },
        {
          id: "item-2",
          title: "Idea item",
          horizon: "NEXT",
          squadId: null,
          solutionId: null,
          keyResultId: null,
          opportunityId: null,
          experimentId: null,
          feedback: { type: "IDEA" },
        },
        {
          id: "item-3",
          title: "No feedback item",
          horizon: "LATER",
          squadId: null,
          solutionId: null,
          keyResultId: null,
          opportunityId: null,
          experimentId: null,
          feedback: null,
        },
      ],
    });

    const result = await getCanvasOverview(prisma, "ws-1");

    expect(result.roadmapItems.find((r) => r.id === "item-1")?.isBug).toBe(true);
    expect(result.roadmapItems.find((r) => r.id === "item-2")?.isBug).toBe(false);
    expect(result.roadmapItems.find((r) => r.id === "item-3")?.isBug).toBe(false);
  });

  it("queries roadmap items with a status: ACTIVE filter, but not opportunities/solutions/assumptions/experiments", async () => {
    const prisma = makeFakePrisma({});
    await getCanvasOverview(prisma, "ws-1");

    expect(prisma.roadmapItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId: "ws-1", status: "ACTIVE" },
      })
    );
    expect(prisma.opportunity.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId: "ws-1" } })
    );
    expect(prisma.experiment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId: "ws-1" } })
    );
  });

  it("attaches a saved canvas position to its matching entity across all 7 types", async () => {
    const prisma = makeFakePrisma({
      objectives: [{ id: "obj-1", title: "Pinned", status: "ON_TRACK", squadId: null }],
      opportunities: [{ id: "opp-1", title: "Opp", status: "EXPLORING", squadId: null, linkedKeyResultId: null }],
      positions: [
        { entityType: "OBJECTIVE", entityId: "obj-1", x: 100, y: 200, pinned: true },
        { entityType: "OPPORTUNITY", entityId: "opp-1", x: 10, y: 20, pinned: false },
      ],
    });

    const result = await getCanvasOverview(prisma, "ws-1");

    expect(result.objectives.find((o) => o.id === "obj-1")?.position).toEqual({ x: 100, y: 200, pinned: true });
    expect(result.opportunities.find((o) => o.id === "opp-1")?.position).toEqual({ x: 10, y: 20, pinned: false });
  });

  it("queries positions covering all 7 CanvasEntityType values and every fetched entity id", async () => {
    const prisma = makeFakePrisma({
      objectives: [{ id: "obj-1", title: "A", status: "ON_TRACK", squadId: null }],
      keyResults: [{ id: "kr-1", objectiveId: "obj-1", title: "KR", current: 0, target: 1, unit: null }],
      opportunities: [{ id: "opp-1", title: "Opp", status: "EXPLORING", squadId: null, linkedKeyResultId: null }],
      solutions: [{ id: "sol-1", opportunityId: "opp-1", title: "Sol", status: "IDEA" }],
      assumptions: [{ id: "as-1", solutionId: "sol-1", title: "A", riskLevel: "LOW", status: "UNTESTED" }],
      experiments: [
        { id: "exp-1", assumptionId: null, title: "Exp", squadId: null, status: "DESIGNING", conclusion: null },
      ],
      roadmapItems: [
        {
          id: "item-1",
          title: "Item",
          horizon: "NOW",
          squadId: null,
          solutionId: null,
          keyResultId: null,
          opportunityId: null,
          experimentId: null,
          feedback: null,
        },
      ],
    });

    await getCanvasOverview(prisma, "ws-1");

    expect(prisma.canvasNodePosition.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          workspaceId: "ws-1",
          entityType: {
            in: [
              "OBJECTIVE",
              "KEY_RESULT",
              "OPPORTUNITY",
              "SOLUTION",
              "ASSUMPTION",
              "EXPERIMENT",
              "ROADMAP_ITEM",
            ],
          },
          entityId: { in: ["obj-1", "kr-1", "opp-1", "sol-1", "as-1", "exp-1", "item-1"] },
        }),
      })
    );
  });

  it("returns objectives with no key results and an empty overview shape for arrays with no rows", async () => {
    const prisma = makeFakePrisma({
      objectives: [{ id: "obj-1", title: "Lonely", status: "ON_TRACK", squadId: null }],
    });

    const result = await getCanvasOverview(prisma, "ws-1");
    expect(result.keyResults).toEqual([]);
    expect(result.opportunities).toEqual([]);
    expect(result.solutions).toEqual([]);
    expect(result.assumptions).toEqual([]);
    expect(result.experiments).toEqual([]);
    expect(result.roadmapItems).toEqual([]);
  });
});
