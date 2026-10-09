import { beforeEach, describe, expect, it, vi } from "vitest";

const tx = {
  keyResult: { findFirst: vi.fn(), update: vi.fn() },
  objective: { findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn() },
  opportunity: { findMany: vi.fn() },
};
const mockSyncLegacyLink = vi.fn();

vi.mock("@/lib/db", () => ({ default: () => tx }));
vi.mock("@/lib/typed-links", () => ({
  runTypedLinkTransaction: (_prisma: unknown, work: (t: typeof tx) => Promise<unknown>) => work(tx),
  syncLegacyLink: (...args: unknown[]) => mockSyncLegacyLink(...args),
}));

import { getKeyResultMoveTargets, moveKeyResultToObjective, OKRHierarchyError } from "@/lib/okr-hierarchy";

const year = { startDate: new Date("2027-01-01"), endDate: new Date("2027-12-31") };
const quarter = { startDate: new Date("2027-01-01"), endDate: new Date("2027-03-31") };
const input = { workspaceId: "ws-1", keyResultId: "kr-1", objectiveId: "obj-2", actorId: "user-1" };

function target(overrides: Record<string, unknown> = {}) {
  return { id: "obj-2", workspaceId: "ws-1", cycle: { status: "ACTIVE", ...year }, ...overrides };
}

async function codeOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (e) {
    expect(e).toBeInstanceOf(OKRHierarchyError);
    return (e as OKRHierarchyError).code;
  }
  throw new Error("expected a rejection");
}

beforeEach(() => {
  vi.clearAllMocks();
  tx.keyResult.findFirst.mockImplementation(async (args: { where: { id?: string; objectiveId?: string } }) =>
    args.where.id === "kr-1" ? { id: "kr-1", objectiveId: "obj-1" } : { sortOrder: 3 },
  );
  tx.keyResult.update.mockResolvedValue({ id: "kr-1", objectiveId: "obj-2", sortOrder: 4 });
  tx.objective.findFirst.mockResolvedValue(target());
  tx.objective.findMany.mockResolvedValue([]);
  tx.objective.findUnique.mockResolvedValue({ parentKeyResultId: null, parentKeyResult: null });
  tx.opportunity.findMany.mockResolvedValue([]);
});

describe("moveKeyResultToObjective", () => {
  it("re-parents the key result at the end of the target's list and re-derives each driven opportunity's LEGACY link", async () => {
    tx.opportunity.findMany.mockResolvedValue([{ id: "opp-1" }, { id: "opp-2" }]);
    const result = await moveKeyResultToObjective(input);

    expect(tx.keyResult.update).toHaveBeenCalledWith({
      where: { id: "kr-1" },
      data: expect.objectContaining({ objectiveId: "obj-2", sortOrder: 4, updatedById: "user-1" }),
    });
    expect(mockSyncLegacyLink).toHaveBeenCalledTimes(2);
    expect(mockSyncLegacyLink).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ opportunityId: "opp-1", workspaceId: "ws-1", keyResultId: "kr-1" }),
    );
    expect(result).toMatchObject({ fromObjectiveId: "obj-1", toObjectiveId: "obj-2" });
  });

  it("starts an empty target's list at 0", async () => {
    tx.keyResult.findFirst.mockImplementation(async (args: { where: { id?: string } }) =>
      args.where.id === "kr-1" ? { id: "kr-1", objectiveId: "obj-1" } : null,
    );
    await moveKeyResultToObjective(input);
    expect(tx.keyResult.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ sortOrder: 0 }) }));
  });

  it("refuses a key result outside the workspace, writing nothing", async () => {
    tx.keyResult.findFirst.mockResolvedValue(null);
    expect(await codeOf(moveKeyResultToObjective(input))).toBe("KEY_RESULT_NOT_FOUND");
    expect(tx.keyResult.update).not.toHaveBeenCalled();
  });

  it("refuses a target objective outside the workspace", async () => {
    tx.objective.findFirst.mockResolvedValue(null);
    expect(await codeOf(moveKeyResultToObjective(input))).toBe("OBJECTIVE_NOT_FOUND");
    expect(tx.objective.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "obj-2", workspaceId: "ws-1" } }));
  });

  it("refuses moving onto the current objective", async () => {
    tx.objective.findFirst.mockResolvedValue(target({ id: "obj-1" }));
    expect(await codeOf(moveKeyResultToObjective({ ...input, objectiveId: "obj-1" }))).toBe("SAME_OBJECTIVE");
  });

  it("refuses a target in a closed cycle", async () => {
    tx.objective.findFirst.mockResolvedValue(target({ cycle: { status: "CLOSED", ...year } }));
    expect(await codeOf(moveKeyResultToObjective(input))).toBe("CLOSED_PARENT_CYCLE");
    expect(tx.keyResult.update).not.toHaveBeenCalled();
  });

  it("allows a cycle-less target", async () => {
    tx.objective.findFirst.mockResolvedValue(target({ cycle: null }));
    await expect(moveKeyResultToObjective(input)).resolves.toBeDefined();
  });

  it("refuses a target cycle that no longer contains a supporting objective's cycle", async () => {
    tx.objective.findMany.mockResolvedValue([{ id: "sup", cycle: year }]);
    tx.objective.findFirst.mockResolvedValue(target({ cycle: { status: "ACTIVE", ...quarter } }));
    expect(await codeOf(moveKeyResultToObjective(input))).toBe("INVALID_TIME_HORIZON");
  });

  it("refuses a target that is the key result's own supporter (direct loop)", async () => {
    tx.objective.findUnique.mockResolvedValue({ parentKeyResultId: "kr-1", parentKeyResult: { objectiveId: "obj-1" } });
    expect(await codeOf(moveKeyResultToObjective(input))).toBe("CIRCULAR_HIERARCHY");
    expect(tx.keyResult.update).not.toHaveBeenCalled();
  });

  it("refuses a target that sits transitively below the key result", async () => {
    tx.objective.findUnique
      .mockResolvedValueOnce({ parentKeyResultId: "kr-x", parentKeyResult: { objectiveId: "obj-mid" } })
      .mockResolvedValueOnce({ parentKeyResultId: "kr-1", parentKeyResult: { objectiveId: "obj-1" } });
    expect(await codeOf(moveKeyResultToObjective(input))).toBe("CIRCULAR_HIERARCHY");
  });

  it("refuses to move a key result that drives too many opportunities for one transaction", async () => {
    tx.opportunity.findMany.mockResolvedValue(Array.from({ length: 401 }, (_, i) => ({ id: `opp-${i}` })));
    await codeOf(moveKeyResultToObjective(input));
    expect(tx.keyResult.update).not.toHaveBeenCalled();
    expect(mockSyncLegacyLink).not.toHaveBeenCalled();
  });
});

describe("getKeyResultMoveTargets", () => {
  const candidate = (id: string, cycle: { title: string; startDate: Date; endDate: Date } | null, cycleId: string | null, sortOrder = 0) => ({
    id,
    title: id,
    sortOrder,
    cycleId,
    cycle,
  });

  beforeEach(() => {
    tx.keyResult.findFirst.mockResolvedValue({ objectiveId: "obj-1", objective: { cycleId: "c-q1" } });
  });

  it("throws when the key result is not in the workspace", async () => {
    tx.keyResult.findFirst.mockResolvedValue(null);
    expect(await codeOf(getKeyResultMoveTargets("ws-1", "kr-1"))).toBe("KEY_RESULT_NOT_FOUND");
  });

  it("excludes descendants and cycles that no longer fit a supporter, and lists same-cycle objectives first", async () => {
    tx.objective.findMany
      .mockResolvedValueOnce([{ id: "sup", cycle: quarter }]) // supporters
      .mockResolvedValueOnce([{ id: "grandchild" }]) // BFS level 1
      .mockResolvedValueOnce([]) // BFS level 2
      .mockResolvedValueOnce([
        candidate("same-cycle-peer", { title: "Q1", ...quarter }, "c-q1"),
        candidate("annual", { title: "2027", ...year }, "c-year"),
        candidate("grandchild", { title: "Q1", ...quarter }, "c-q1"),
        candidate("sup", { title: "Q1", ...quarter }, "c-q1"),
        candidate("persistent", null, null),
      ]);

    const targets = await getKeyResultMoveTargets("ws-1", "kr-1");
    // "same-cycle-peer" has the same window as its supporter, so it cannot contain it; "annual" and the cycle-less one can.
    expect(targets.map((t) => t.id)).toEqual(["annual", "persistent"]);
    expect(targets[1].cycleTitle).toBeTruthy();
  });
});
