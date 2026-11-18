import { beforeEach, describe, expect, it, vi } from "vitest";
import { hashRows, isLiveScope } from "@/lib/live-change-token";

describe("hashRows", () => {
  const rows = [
    { id: "1", status: "EXPLORING", sortOrder: 0 },
    { id: "2", status: "ACTIVE", sortOrder: 1 },
  ];

  it("is stable and independent of row order", () => {
    expect(hashRows([rows])).toBe(hashRows([[...rows].reverse()]));
  });

  it("changes on a status move even when updatedAt is untouched", () => {
    const moved = [{ ...rows[0], status: "VALIDATING" }, rows[1]];
    expect(hashRows([moved])).not.toBe(hashRows([rows]));
  });

  it("changes on a pure reorder, an addition and a deletion", () => {
    const base = hashRows([rows]);
    expect(hashRows([[{ ...rows[0], sortOrder: 5 }, rows[1]]])).not.toBe(base);
    expect(hashRows([[...rows, { id: "3", status: "ACTIVE", sortOrder: 2 }]])).not.toBe(base);
    expect(hashRows([[rows[0]]])).not.toBe(base);
  });

  it("does not let a row migrate between groups unnoticed", () => {
    expect(hashRows([[rows[0]], [rows[1]]])).not.toBe(hashRows([[rows[0], rows[1]], []]));
  });
});

describe("isLiveScope", () => {
  it("accepts known scopes only", () => {
    expect(isLiveScope("tasks")).toBe(true);
    expect(isLiveScope("opportunities")).toBe(true);
    expect(isLiveScope("roadmap")).toBe(true);
    expect(isLiveScope("cardSort")).toBe(true);
    expect(isLiveScope("okrs")).toBe(true);
    expect(isLiveScope("users")).toBe(false);
    expect(isLiveScope(null)).toBe(false);
  });
});

describe("computeChangeToken okrs scope", () => {
  const mockPrisma = {
    oKRCycle: { findMany: vi.fn() },
    objective: { findMany: vi.fn() },
    keyResult: { findMany: vi.fn() },
    checkIn: { count: vi.fn() },
    customFieldValue: { findMany: vi.fn() },
  };

  async function token() {
    vi.resetModules();
    vi.doMock("@/lib/db", () => ({ default: () => mockPrisma }));
    const mod = await import("@/lib/live-change-token");
    return mod.computeChangeToken("okrs", "ws-1");
  }

  const objective = { id: "o1", cycleId: "c1", title: "Grow", status: "ACTIVE", sortOrder: 0 };
  const keyResult = { id: "k1", objectiveId: "o1", title: "Users", target: 10, current: 1, sortOrder: 0 };

  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.oKRCycle.findMany.mockResolvedValue([{ id: "c1", title: "Q1", status: "ACTIVE" }]);
    mockPrisma.objective.findMany.mockResolvedValue([objective]);
    mockPrisma.keyResult.findMany.mockResolvedValue([keyResult]);
    mockPrisma.checkIn.count.mockResolvedValue(2);
    mockPrisma.customFieldValue.findMany.mockResolvedValue([]);
  });

  it("scopes every query to the workspace", async () => {
    await token();
    expect(mockPrisma.oKRCycle.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { workspaceId: "ws-1" } }));
    expect(mockPrisma.objective.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { workspaceId: "ws-1" } }));
    expect(mockPrisma.keyResult.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { objective: { workspaceId: "ws-1" } } }),
    );
    expect(mockPrisma.checkIn.count).toHaveBeenCalledWith({ where: { keyResult: { objective: { workspaceId: "ws-1" } } } });
    expect(mockPrisma.customFieldValue.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { objectId: { in: ["o1"] } } }),
    );
  });

  it("is stable when nothing changed", async () => {
    expect(await token()).toBe(await token());
  });

  it("changes on a key result check-in (current moves), a new check-in, and a reorder", async () => {
    const base = await token();
    mockPrisma.keyResult.findMany.mockResolvedValue([{ ...keyResult, current: 5 }]);
    expect(await token()).not.toBe(base);
    mockPrisma.keyResult.findMany.mockResolvedValue([keyResult]);
    mockPrisma.checkIn.count.mockResolvedValue(3);
    expect(await token()).not.toBe(base);
    mockPrisma.checkIn.count.mockResolvedValue(2);
    mockPrisma.objective.findMany.mockResolvedValue([{ ...objective, sortOrder: 4 }]);
    expect(await token()).not.toBe(base);
  });

  it("skips the custom-field query when the workspace has no objectives", async () => {
    mockPrisma.objective.findMany.mockResolvedValue([]);
    await token();
    expect(mockPrisma.customFieldValue.findMany).not.toHaveBeenCalled();
  });
});
