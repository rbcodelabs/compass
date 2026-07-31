import { describe, it, expect, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { getCanvasOverview } from "@/lib/canvas/data";

/**
 * getCanvasOverview takes its PrismaClient as an explicit argument (not via
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
}): PrismaClient {
  return {
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
};

describe("getCanvasOverview", () => {
  it("returns an empty overview for a workspace with no data", async () => {
    const prisma = makeFakePrisma({});
    const result = await getCanvasOverview(prisma, "ws-1");
    expect(result).toEqual(EMPTY_OVERVIEW);
  });

  it("does not query key results, solutions, assumptions, or positions when there are no objectives/opportunities/solutions", async () => {
    const prisma = makeFakePrisma({});
    await getCanvasOverview(prisma, "ws-1");
    expect(prisma.keyResult.findMany).not.toHaveBeenCalled();
    expect(prisma.solution.findMany).not.toHaveBeenCalled();
    expect(prisma.assumption.findMany).not.toHaveBeenCalled();
    expect(prisma.canvasNodePosition.findMany).not.toHaveBeenCalled();
  });

  it("scopes the objective query to the workspace across all cycles", async () => {
    const prisma = makeFakePrisma({});
    await getCanvasOverview(prisma, "ws-1");
    expect(prisma.objective.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { cycle: { workspaceId: "ws-1" } },
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
      { id: "opp-1", title: "Linked", status: "VALIDATING", squad: null, linkedKeyResultId: "kr-1", position: null },
      { id: "opp-2", title: "Unlinked", status: "EXPLORING", squad: null, linkedKeyResultId: null, position: null },
    ]);
  });

  it("maps solutions scoped to fetched opportunity ids", async () => {
    const prisma = makeFakePrisma({
      opportunities: [{ id: "opp-1", title: "Opp", status: "EXPLORING", squadId: null, linkedKeyResultId: null }],
      solutions: [{ id: "sol-1", opportunityId: "opp-1", title: "Sol", status: "IDEA" }],
    });

    const result = await getCanvasOverview(prisma, "ws-1");

    expect(prisma.solution.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { opportunityId: { in: ["opp-1"] } } })
    );
    expect(result.solutions).toEqual([
      { id: "sol-1", opportunityId: "opp-1", title: "Sol", status: "IDEA", position: null },
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
