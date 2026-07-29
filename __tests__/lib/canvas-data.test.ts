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
    canvasNodePosition: {
      findMany: vi.fn().mockResolvedValue(overrides.positions ?? []),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe("getCanvasOverview", () => {
  it("returns an empty objectives array for a workspace with no OKR data", async () => {
    const prisma = makeFakePrisma({});
    const result = await getCanvasOverview(prisma, "ws-1");
    expect(result).toEqual({ objectives: [] });
  });

  it("does not query key results or positions when there are no objectives", async () => {
    const prisma = makeFakePrisma({});
    await getCanvasOverview(prisma, "ws-1");
    expect(prisma.keyResult.findMany).not.toHaveBeenCalled();
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

    expect(result.objectives).toHaveLength(1);
    expect(result.objectives[0].keyResults).toEqual([
      { id: "kr-1", title: "Hit $1M ARR", current: 50, target: 100, unit: "%" },
      { id: "kr-2", title: "Sign 10 logos", current: 3, target: 10, unit: null },
    ]);
  });

  it("attaches squad data by squadId", async () => {
    const prisma = makeFakePrisma({
      squads: [{ id: "sq-1", name: "Growth", color: "#6366f1" }],
      objectives: [
        { id: "obj-1", title: "With squad", status: "ON_TRACK", squadId: "sq-1" },
        { id: "obj-2", title: "No squad", status: "ON_TRACK", squadId: null },
      ],
    });

    const result = await getCanvasOverview(prisma, "ws-1");

    const withSquad = result.objectives.find((o) => o.id === "obj-1");
    const noSquad = result.objectives.find((o) => o.id === "obj-2");
    expect(withSquad?.squad).toEqual({ id: "sq-1", name: "Growth", color: "#6366f1" });
    expect(noSquad?.squad).toBeNull();
  });

  it("attaches a saved canvas position to its matching objective", async () => {
    const prisma = makeFakePrisma({
      objectives: [
        { id: "obj-1", title: "Pinned", status: "ON_TRACK", squadId: null },
        { id: "obj-2", title: "Unpinned", status: "ON_TRACK", squadId: null },
      ],
      positions: [
        { entityType: "OBJECTIVE", entityId: "obj-1", x: 100, y: 200, pinned: true },
      ],
    });

    const result = await getCanvasOverview(prisma, "ws-1");

    const pinned = result.objectives.find((o) => o.id === "obj-1");
    const unpinned = result.objectives.find((o) => o.id === "obj-2");
    expect(pinned?.position).toEqual({ x: 100, y: 200, pinned: true });
    expect(unpinned?.position).toBeNull();
  });

  it("queries positions for both OBJECTIVE and KEY_RESULT entity ids in one round-trip", async () => {
    const prisma = makeFakePrisma({
      objectives: [{ id: "obj-1", title: "A", status: "ON_TRACK", squadId: null }],
      keyResults: [
        { id: "kr-1", objectiveId: "obj-1", title: "KR", current: 0, target: 1, unit: null },
      ],
    });

    await getCanvasOverview(prisma, "ws-1");

    expect(prisma.canvasNodePosition.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          workspaceId: "ws-1",
          entityType: { in: ["OBJECTIVE", "KEY_RESULT"] },
          entityId: { in: ["obj-1", "kr-1"] },
        }),
      })
    );
  });

  it("returns objectives with no key results as an empty array, not undefined", async () => {
    const prisma = makeFakePrisma({
      objectives: [{ id: "obj-1", title: "Lonely", status: "ON_TRACK", squadId: null }],
    });

    const result = await getCanvasOverview(prisma, "ws-1");
    expect(result.objectives[0].keyResults).toEqual([]);
  });
});
