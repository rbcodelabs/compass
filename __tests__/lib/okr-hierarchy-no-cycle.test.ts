import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Migration 069: Objective.cycleId is optional. Containment and CLOSED-cycle
 * checks have an explicit "no cycle" case: skipped, never failed, never thrown.
 */

const mockCycleFindFirst = vi.fn();
const mockKRFindMany = vi.fn();
const mockKRFindFirst = vi.fn();
const mockObjectiveFindFirst = vi.fn();
const mockObjectiveFindMany = vi.fn();
const mockObjectiveFindUnique = vi.fn();
const mockObjectiveUpdate = vi.fn();

vi.mock("@/lib/db", () => ({
  default: () => ({
    oKRCycle: { findFirst: mockCycleFindFirst },
    keyResult: { findMany: mockKRFindMany, findFirst: mockKRFindFirst },
    objective: {
      findFirst: mockObjectiveFindFirst,
      findMany: mockObjectiveFindMany,
      findUnique: mockObjectiveFindUnique,
      update: mockObjectiveUpdate,
    },
  }),
}));

import {
  getEligibleParentKeyResults,
  getEligibleSupportingObjectives,
  setObjectiveParentKeyResult,
} from "@/lib/okr-hierarchy";
import { NO_CYCLE_LABEL } from "@/lib/okr-cycle-scope";

const annualCycle = {
  id: "annual",
  workspaceId: "ws-1",
  title: "2027 Annual",
  status: "ACTIVE",
  startDate: new Date("2027-01-01"),
  endDate: new Date("2027-12-31"),
};
const quarterlyCycle = {
  id: "q1",
  workspaceId: "ws-1",
  title: "Q1 2027",
  status: "ACTIVE",
  startDate: new Date("2027-01-01"),
  endDate: new Date("2027-03-31"),
};

beforeEach(() => {
  vi.clearAllMocks();
  mockObjectiveUpdate.mockResolvedValue({ id: "child" });
  mockObjectiveFindUnique.mockResolvedValue({ parentKeyResult: null });
});

describe("getEligibleParentKeyResults with a cycle-less parent or child", () => {
  it("offers a cycle-less parent Objective's KR to a cycled child, after cycled parents", async () => {
    mockCycleFindFirst.mockResolvedValue(quarterlyCycle);
    mockKRFindMany.mockResolvedValue([
      {
        id: "persistent-kr",
        title: "Always-on KR",
        sortOrder: 0,
        objective: { id: "persistent-objective", title: "Persistent", sortOrder: 0, cycle: null },
      },
      {
        id: "annual-kr",
        title: "Annual KR",
        sortOrder: 0,
        objective: { id: "annual-objective", title: "Annual", sortOrder: 0, cycle: annualCycle },
      },
    ]);

    const result = await getEligibleParentKeyResults("ws-1", "q1");
    expect(result.map((kr) => kr.id)).toEqual(["annual-kr", "persistent-kr"]);
    expect(result[1]).toMatchObject({ cycleId: null, cycleTitle: NO_CYCLE_LABEL, cycleStatus: null });
  });

  it("with no child cycle, skips containment entirely and never reads a cycle row", async () => {
    mockKRFindMany.mockResolvedValue([
      {
        id: "annual-kr",
        title: "Annual KR",
        sortOrder: 0,
        objective: { id: "annual-objective", title: "Annual", sortOrder: 0, cycle: annualCycle },
      },
      {
        id: "quarter-kr",
        title: "Quarter KR",
        sortOrder: 0,
        objective: { id: "q-objective", title: "Quarter", sortOrder: 0, cycle: quarterlyCycle },
      },
    ]);

    const result = await getEligibleParentKeyResults("ws-1", null, { excludeObjectiveId: "self" });
    expect(mockCycleFindFirst).not.toHaveBeenCalled();
    // Both cycles qualify: no dates to compare against.
    expect(result.map((kr) => kr.id).sort()).toEqual(["annual-kr", "quarter-kr"]);
    const where = mockKRFindMany.mock.calls[0][0].where;
    expect(where.objective).toMatchObject({ workspaceId: "ws-1", id: { not: "self" } });
    // CLOSED cycles are still excluded, cycle-less parents still allowed.
    expect(where.objective.OR).toEqual([
      { cycleId: null },
      { cycle: { status: { in: ["DRAFT", "ACTIVE"] } } },
    ]);
  });

  it("does not throw when a returned KR belongs to a cycle-less Objective and the child is cycle-less", async () => {
    mockKRFindMany.mockResolvedValue([
      {
        id: "persistent-kr",
        title: "Always-on KR",
        sortOrder: 0,
        objective: { id: "persistent-objective", title: "Persistent", sortOrder: 0, cycle: null },
      },
    ]);
    await expect(getEligibleParentKeyResults("ws-1", null)).resolves.toEqual([
      expect.objectContaining({ id: "persistent-kr", cycleId: null, cycleTitle: NO_CYCLE_LABEL }),
    ]);
  });
});

describe("getEligibleSupportingObjectives with cycle-less Objectives", () => {
  it("includes cycle-less Objectives as candidates under a cycled parent", async () => {
    mockCycleFindFirst.mockResolvedValue(annualCycle);
    mockObjectiveFindMany.mockResolvedValue([
      { id: "quarterly-objective", title: "Quarterly", sortOrder: 0, cycle: quarterlyCycle },
      { id: "persistent-objective", title: "Persistent", sortOrder: 1, cycle: null },
    ]);
    await expect(getEligibleSupportingObjectives("ws-1", "annual")).resolves.toEqual([
      expect.objectContaining({ id: "quarterly-objective", cycleId: "q1" }),
      expect.objectContaining({ id: "persistent-objective", cycleId: null, cycleTitle: NO_CYCLE_LABEL }),
    ]);
  });

  it("with a cycle-less parent, offers unlinked Objectives from every cycle and never reads a cycle row", async () => {
    mockObjectiveFindMany.mockResolvedValue([
      { id: "quarterly-objective", title: "Quarterly", sortOrder: 0, cycle: quarterlyCycle },
      { id: "persistent-peer", title: "Peer", sortOrder: 1, cycle: null },
    ]);
    const result = await getEligibleSupportingObjectives("ws-1", null);
    expect(mockCycleFindFirst).not.toHaveBeenCalled();
    expect(result.map((o) => o.id)).toEqual(["quarterly-objective", "persistent-peer"]);
    expect(mockObjectiveFindMany.mock.calls[0][0].where).toEqual({ parentKeyResultId: null, workspaceId: "ws-1" });
  });
});

describe("setObjectiveParentKeyResult with cycle-less Objectives", () => {
  it("links a cycle-less Objective to a KR in any open cycle (containment skipped)", async () => {
    mockObjectiveFindFirst.mockResolvedValue({ id: "child", cycle: null });
    mockKRFindFirst.mockResolvedValue({
      id: "annual-kr",
      objectiveId: "annual-objective",
      objective: { id: "annual-objective", cycle: annualCycle },
    });
    await setObjectiveParentKeyResult({ workspaceId: "ws-1", objectiveId: "child", keyResultId: "annual-kr" });
    expect(mockObjectiveUpdate).toHaveBeenCalledWith({
      where: { id: "child" },
      data: { parentKeyResultId: "annual-kr", updatedAt: expect.any(Date) },
    });
  });

  it("links a cycled Objective to a cycle-less parent KR (containment skipped)", async () => {
    mockObjectiveFindFirst.mockResolvedValue({ id: "child", cycle: quarterlyCycle });
    mockKRFindFirst.mockResolvedValue({
      id: "persistent-kr",
      objectiveId: "persistent-objective",
      objective: { id: "persistent-objective", cycle: null },
    });
    await setObjectiveParentKeyResult({ workspaceId: "ws-1", objectiveId: "child", keyResultId: "persistent-kr" });
    expect(mockObjectiveUpdate).toHaveBeenCalledTimes(1);
  });

  it("links two cycle-less Objectives", async () => {
    mockObjectiveFindFirst.mockResolvedValue({ id: "child", cycle: null });
    mockKRFindFirst.mockResolvedValue({
      id: "persistent-kr",
      objectiveId: "persistent-objective",
      objective: { id: "persistent-objective", cycle: null },
    });
    await setObjectiveParentKeyResult({ workspaceId: "ws-1", objectiveId: "child", keyResultId: "persistent-kr" });
    expect(mockObjectiveUpdate).toHaveBeenCalledTimes(1);
  });

  it("still rejects a CLOSED parent cycle for a cycle-less child", async () => {
    mockObjectiveFindFirst.mockResolvedValue({ id: "child", cycle: null });
    mockKRFindFirst.mockResolvedValue({
      id: "annual-kr",
      objectiveId: "annual-objective",
      objective: { id: "annual-objective", cycle: { ...annualCycle, status: "CLOSED" } },
    });
    await expect(
      setObjectiveParentKeyResult({ workspaceId: "ws-1", objectiveId: "child", keyResultId: "annual-kr" })
    ).rejects.toMatchObject({ code: "CLOSED_PARENT_CYCLE" });
  });

  it("still rejects an Objective supporting its own KR and indirect loops when cycle-less", async () => {
    mockObjectiveFindFirst.mockResolvedValue({ id: "child", cycle: null });
    mockKRFindFirst.mockResolvedValue({
      id: "own-kr",
      objectiveId: "child",
      objective: { id: "child", cycle: null },
    });
    await expect(
      setObjectiveParentKeyResult({ workspaceId: "ws-1", objectiveId: "child", keyResultId: "own-kr" })
    ).rejects.toMatchObject({ code: "SAME_OBJECTIVE" });

    mockKRFindFirst.mockResolvedValue({
      id: "persistent-kr",
      objectiveId: "persistent-objective",
      objective: { id: "persistent-objective", cycle: null },
    });
    mockObjectiveFindUnique.mockResolvedValueOnce({ parentKeyResult: { objectiveId: "child" } });
    await expect(
      setObjectiveParentKeyResult({ workspaceId: "ws-1", objectiveId: "child", keyResultId: "persistent-kr" })
    ).rejects.toMatchObject({ code: "CIRCULAR_HIERARCHY" });
  });

  it("keeps the workspace boundary: a KR outside the workspace is still not found", async () => {
    mockObjectiveFindFirst.mockResolvedValue({ id: "child", cycle: null });
    mockKRFindFirst.mockResolvedValue(null);
    await expect(
      setObjectiveParentKeyResult({ workspaceId: "ws-1", objectiveId: "child", keyResultId: "other-ws-kr" })
    ).rejects.toMatchObject({ code: "KEY_RESULT_NOT_FOUND" });
    expect(mockKRFindFirst.mock.calls[0][0].where.objective).toEqual({ workspaceId: "ws-1" });
  });
});
