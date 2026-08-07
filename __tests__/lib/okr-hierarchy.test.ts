import { beforeEach, describe, expect, it, vi } from "vitest";

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
  getEligibleSupportingObjectives,
  getEligibleParentKeyResults,
  OKRHierarchyError,
  setObjectiveParentKeyResult,
} from "@/lib/okr-hierarchy";

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
  mockObjectiveUpdate.mockResolvedValue({ id: "quarterly-objective" });
  mockObjectiveFindUnique.mockResolvedValue({ parentKeyResult: null });
});

describe("getEligibleParentKeyResults", () => {
  it("returns and formats KRs from containing cycles", async () => {
    mockCycleFindFirst.mockResolvedValue(quarterlyCycle);
    mockKRFindMany.mockResolvedValue([
      {
        id: "annual-kr",
        title: "Reach $2M ARR",
        sortOrder: 0,
        objective: {
          id: "annual-objective",
          title: "Grow recurring revenue",
          sortOrder: 0,
          cycle: annualCycle,
        },
      },
    ]);

    await expect(getEligibleParentKeyResults("ws-1", "q1")).resolves.toEqual([
      expect.objectContaining({
        id: "annual-kr",
        cycleTitle: "2027 Annual",
        objectiveTitle: "Grow recurring revenue",
      }),
    ]);
    expect(mockKRFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          objective: expect.objectContaining({
            cycle: expect.objectContaining({ workspaceId: "ws-1", id: { not: "q1" } }),
          }),
        }),
      })
    );
  });

  it("returns no candidates when the child cycle is outside the workspace", async () => {
    mockCycleFindFirst.mockResolvedValue(null);
    await expect(getEligibleParentKeyResults("ws-1", "missing")).resolves.toEqual([]);
    expect(mockKRFindMany).not.toHaveBeenCalled();
  });

  it("excludes a separate cycle with identical dates", async () => {
    mockCycleFindFirst.mockResolvedValue(quarterlyCycle);
    mockKRFindMany.mockResolvedValue([
      {
        id: "peer-kr",
        title: "Peer KR",
        sortOrder: 0,
        objective: {
          id: "peer-objective",
          title: "Peer Objective",
          sortOrder: 0,
          cycle: { ...quarterlyCycle, id: "peer-cycle" },
        },
      },
    ]);
    await expect(getEligibleParentKeyResults("ws-1", "q1")).resolves.toEqual([]);
  });
});

describe("getEligibleSupportingObjectives", () => {
  it("returns unlinked Objectives from strictly shorter contained cycles", async () => {
    mockCycleFindFirst.mockResolvedValue(annualCycle);
    mockObjectiveFindMany.mockResolvedValue([
      {
        id: "quarterly-objective",
        title: "Win the enterprise segment",
        sortOrder: 0,
        cycle: quarterlyCycle,
      },
      {
        id: "peer-objective",
        title: "Same-horizon peer",
        sortOrder: 1,
        cycle: { ...annualCycle, id: "annual-peer" },
      },
    ]);

    await expect(getEligibleSupportingObjectives("ws-1", "annual")).resolves.toEqual([
      expect.objectContaining({
        id: "quarterly-objective",
        cycleTitle: "Q1 2027",
      }),
    ]);
    expect(mockObjectiveFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          parentKeyResultId: null,
          cycle: expect.objectContaining({ workspaceId: "ws-1", id: { not: "annual" } }),
        }),
      })
    );
  });

  it("returns no candidates when the parent cycle is closed", async () => {
    mockCycleFindFirst.mockResolvedValue({ ...annualCycle, status: "CLOSED" });
    await expect(getEligibleSupportingObjectives("ws-1", "annual")).resolves.toEqual([]);
    expect(mockObjectiveFindMany).not.toHaveBeenCalled();
  });
});

describe("setObjectiveParentKeyResult", () => {
  function arrangeValidLink() {
    mockObjectiveFindFirst.mockResolvedValue({ id: "quarterly-objective", cycle: quarterlyCycle });
    mockKRFindFirst.mockResolvedValue({
      id: "annual-kr",
      objectiveId: "annual-objective",
      objective: { id: "annual-objective", cycle: annualCycle },
    });
  }

  it("links a quarterly Objective to an annual KR", async () => {
    arrangeValidLink();
    await setObjectiveParentKeyResult({
      workspaceId: "ws-1",
      objectiveId: "quarterly-objective",
      keyResultId: "annual-kr",
    });
    expect(mockObjectiveUpdate).toHaveBeenCalledWith({
      where: { id: "quarterly-objective" },
      data: { parentKeyResultId: "annual-kr", updatedAt: expect.any(Date) },
    });
  });

  it("clears an existing hierarchy relationship", async () => {
    mockObjectiveFindFirst.mockResolvedValue({ id: "quarterly-objective", cycle: quarterlyCycle });
    await setObjectiveParentKeyResult({
      workspaceId: "ws-1",
      objectiveId: "quarterly-objective",
      keyResultId: null,
    });
    expect(mockObjectiveUpdate).toHaveBeenCalledWith({
      where: { id: "quarterly-objective" },
      data: { parentKeyResultId: null, updatedAt: expect.any(Date) },
    });
  });

  it("rejects a KR outside the workspace", async () => {
    mockObjectiveFindFirst.mockResolvedValue({ id: "quarterly-objective", cycle: quarterlyCycle });
    mockKRFindFirst.mockResolvedValue(null);
    await expect(
      setObjectiveParentKeyResult({ workspaceId: "ws-1", objectiveId: "quarterly-objective", keyResultId: "other" })
    ).rejects.toMatchObject({ code: "KEY_RESULT_NOT_FOUND" });
  });

  it("rejects a sibling or shorter time horizon", async () => {
    mockObjectiveFindFirst.mockResolvedValue({ id: "quarterly-objective", cycle: quarterlyCycle });
    mockKRFindFirst.mockResolvedValue({
      id: "q2-kr",
      objectiveId: "q2-objective",
      objective: {
        id: "q2-objective",
        cycle: {
          ...quarterlyCycle,
          id: "q2",
          startDate: new Date("2027-04-01"),
          endDate: new Date("2027-06-30"),
        },
      },
    });
    await expect(
      setObjectiveParentKeyResult({ workspaceId: "ws-1", objectiveId: "quarterly-objective", keyResultId: "q2-kr" })
    ).rejects.toMatchObject({ code: "INVALID_TIME_HORIZON" });
  });

  it("rejects a closed parent cycle", async () => {
    arrangeValidLink();
    mockKRFindFirst.mockResolvedValue({
      id: "annual-kr",
      objectiveId: "annual-objective",
      objective: { id: "annual-objective", cycle: { ...annualCycle, status: "CLOSED" } },
    });
    await expect(
      setObjectiveParentKeyResult({ workspaceId: "ws-1", objectiveId: "quarterly-objective", keyResultId: "annual-kr" })
    ).rejects.toMatchObject({ code: "CLOSED_PARENT_CYCLE" });
  });

  it("rejects an Objective supporting its own KR", async () => {
    arrangeValidLink();
    mockKRFindFirst.mockResolvedValue({
      id: "own-kr",
      objectiveId: "quarterly-objective",
      objective: { id: "quarterly-objective", cycle: annualCycle },
    });
    await expect(
      setObjectiveParentKeyResult({ workspaceId: "ws-1", objectiveId: "quarterly-objective", keyResultId: "own-kr" })
    ).rejects.toBeInstanceOf(OKRHierarchyError);
  });

  it("rejects an indirect hierarchy cycle", async () => {
    arrangeValidLink();
    mockObjectiveFindUnique.mockResolvedValueOnce({
      parentKeyResult: { objectiveId: "quarterly-objective" },
    });
    await expect(
      setObjectiveParentKeyResult({ workspaceId: "ws-1", objectiveId: "quarterly-objective", keyResultId: "annual-kr" })
    ).rejects.toMatchObject({ code: "CIRCULAR_HIERARCHY" });
  });
});
