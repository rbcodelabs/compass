import { describe, it, expect, vi, beforeEach } from "vitest";

const mockExperiment = {
  create: vi.fn(),
  update: vi.fn(),
  findFirst: vi.fn(),
};
const mockAssumption = {
  update: vi.fn(),
};

const mockPrisma = {
  experiment: mockExperiment,
  assumption: mockAssumption,
};

vi.mock("@/lib/db", () => ({
  default: vi.fn(() => mockPrisma),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import {
  createExperiment,
  startExperiment,
  logResult,
  concludeExperiment,
  archiveExperiment,
  moveExperiment,
  reorderExperiment,
} from "@/app/[orgSlug]/[workspaceSlug]/experiments/actions";

beforeEach(() => {
  vi.clearAllMocks();
  mockExperiment.create.mockResolvedValue({
    id: "exp-1",
    title: "Test Experiment",
    assumptionId: null,
  });
  mockExperiment.update.mockResolvedValue({
    id: "exp-1",
    status: "RUNNING",
    assumptionId: null,
  });
  mockExperiment.findFirst.mockResolvedValue(null);
  mockAssumption.update.mockResolvedValue({ id: "ass-1" });
});

// ─── createExperiment ─────────────────────────────────────────────────────────

describe("createExperiment", () => {
  it("creates an experiment with DESIGNING status", async () => {
    const result = await createExperiment("ws-1", {
      title: "Do users click CTA?",
      hypothesis: "If we move the CTA, more users will click",
      method: "A/B test",
      killCondition: "CTR < 5%",
    });
    expect(mockExperiment.create).toHaveBeenCalledOnce();
    const data = mockExperiment.create.mock.calls[0][0].data;
    expect(data.status).toBe("DESIGNING");
    expect(data.title).toBe("Do users click CTA?");
    expect(result).toMatchObject({ id: "exp-1" });
  });

  it("sets assumptionId to null when not provided", async () => {
    await createExperiment("ws-1", {
      title: "Exp A",
      hypothesis: "H",
      method: "M",
      killCondition: "K",
    });
    const data = mockExperiment.create.mock.calls[0][0].data;
    expect(data.assumptionId).toBeNull();
  });

  it("passes through an assumptionId when provided", async () => {
    await createExperiment("ws-1", {
      title: "Exp B",
      hypothesis: "H",
      method: "M",
      killCondition: "K",
      assumptionId: "ass-99",
    });
    const data = mockExperiment.create.mock.calls[0][0].data;
    expect(data.assumptionId).toBe("ass-99");
  });

  it("sets squadId to null when not provided", async () => {
    await createExperiment("ws-1", {
      title: "Exp C",
      hypothesis: "H",
      method: "M",
      killCondition: "K",
    });
    const data = mockExperiment.create.mock.calls[0][0].data;
    expect(data.squadId).toBeNull();
  });

  it("propagates DB errors", async () => {
    mockExperiment.create.mockRejectedValue(new Error("DB error"));
    await expect(
      createExperiment("ws-1", {
        title: "Exp D",
        hypothesis: "H",
        method: "M",
        killCondition: "K",
      })
    ).rejects.toThrow("DB error");
  });
});

// ─── startExperiment ─────────────────────────────────────────────────────────

describe("startExperiment", () => {
  it("sets status to RUNNING and records startDate", async () => {
    await startExperiment("exp-1");
    const data = mockExperiment.update.mock.calls[0][0].data;
    expect(data.status).toBe("RUNNING");
    expect(data.startDate).toBeInstanceOf(Date);
  });

  it("propagates DB errors", async () => {
    mockExperiment.update.mockRejectedValue(new Error("not found"));
    await expect(startExperiment("exp-999")).rejects.toThrow("not found");
  });
});

// ─── logResult ───────────────────────────────────────────────────────────────

describe("logResult", () => {
  const mockExperimentResult = { create: vi.fn() };

  beforeEach(() => {
    // Add experimentResult to prisma mock
    (mockPrisma as unknown as Record<string, unknown>).experimentResult = mockExperimentResult;
    mockExperimentResult.create.mockResolvedValue({ id: "result-1" });
  });

  it("creates a result with note", async () => {
    await logResult("exp-1", { note: "Promising early results" });
    expect(mockExperimentResult.create).toHaveBeenCalledOnce();
    const data = mockExperimentResult.create.mock.calls[0][0].data;
    expect(data.note).toBe("Promising early results");
    expect(data.experimentId).toBe("exp-1");
  });

  it("sets metric and value to null when not provided", async () => {
    await logResult("exp-1", { note: "Update" });
    const data = mockExperimentResult.create.mock.calls[0][0].data;
    expect(data.metric).toBeNull();
    expect(data.value).toBeNull();
  });

  it("passes through metric and value when provided", async () => {
    await logResult("exp-1", { note: "Update", metric: "CTR", value: 12.5 });
    const data = mockExperimentResult.create.mock.calls[0][0].data;
    expect(data.metric).toBe("CTR");
    expect(data.value).toBe(12.5);
  });
});

// ─── concludeExperiment ───────────────────────────────────────────────────────

describe("concludeExperiment", () => {
  it("sets status to KILLED when conclusion is KILL", async () => {
    await concludeExperiment("exp-1", "KILL");
    const data = mockExperiment.update.mock.calls[0][0].data;
    expect(data.status).toBe("KILLED");
    expect(data.conclusion).toBe("KILL");
    expect(data.endDate).toBeInstanceOf(Date);
  });

  it("sets status to COMPLETE when conclusion is PROCEED", async () => {
    await concludeExperiment("exp-1", "PROCEED");
    const data = mockExperiment.update.mock.calls[0][0].data;
    expect(data.status).toBe("COMPLETE");
    expect(data.conclusion).toBe("PROCEED");
  });

  it("sets status to COMPLETE when conclusion is ITERATE", async () => {
    await concludeExperiment("exp-1", "ITERATE");
    const data = mockExperiment.update.mock.calls[0][0].data;
    expect(data.status).toBe("COMPLETE");
  });

  it("updates linked assumption to VALIDATED when PROCEED", async () => {
    mockExperiment.update.mockResolvedValue({
      id: "exp-1",
      status: "COMPLETE",
      conclusion: "PROCEED",
      assumptionId: "ass-1",
    });
    await concludeExperiment("exp-1", "PROCEED");
    expect(mockAssumption.update).toHaveBeenCalledWith({
      where: { id: "ass-1" },
      data: { status: "VALIDATED" },
    });
  });

  it("updates linked assumption to INVALIDATED when KILL", async () => {
    mockExperiment.update.mockResolvedValue({
      id: "exp-1",
      status: "KILLED",
      conclusion: "KILL",
      assumptionId: "ass-1",
    });
    await concludeExperiment("exp-1", "KILL");
    expect(mockAssumption.update).toHaveBeenCalledWith({
      where: { id: "ass-1" },
      data: { status: "INVALIDATED" },
    });
  });

  it("updates linked assumption to UNTESTED when ITERATE", async () => {
    mockExperiment.update.mockResolvedValue({
      id: "exp-1",
      status: "COMPLETE",
      conclusion: "ITERATE",
      assumptionId: "ass-1",
    });
    await concludeExperiment("exp-1", "ITERATE");
    expect(mockAssumption.update).toHaveBeenCalledWith({
      where: { id: "ass-1" },
      data: { status: "UNTESTED" },
    });
  });

  it("does not update assumption when experiment has no assumptionId", async () => {
    mockExperiment.update.mockResolvedValue({
      id: "exp-1",
      status: "COMPLETE",
      assumptionId: null,
    });
    await concludeExperiment("exp-1", "PROCEED");
    expect(mockAssumption.update).not.toHaveBeenCalled();
  });
});

// ─── archiveExperiment ────────────────────────────────────────────────────────

describe("archiveExperiment", () => {
  it("sets status to KILLED", async () => {
    await archiveExperiment("exp-1", "/path");
    expect(mockExperiment.update).toHaveBeenCalledWith({
      where: { id: "exp-1" },
      data: { status: "KILLED" },
    });
  });
});

// ─── moveExperiment ───────────────────────────────────────────────────────────

describe("moveExperiment", () => {
  it("places experiment at sortOrder 0 when column is empty", async () => {
    mockExperiment.findFirst.mockResolvedValue(null);
    await moveExperiment("exp-1", "RUNNING", "ws-1", "/path");
    const data = mockExperiment.update.mock.calls[0][0].data;
    expect(data.sortOrder).toBe(0);
    expect(data.status).toBe("RUNNING");
  });

  it("places experiment after last item in destination column", async () => {
    mockExperiment.findFirst.mockResolvedValue({ sortOrder: 3 });
    await moveExperiment("exp-1", "COMPLETE", "ws-1", "/path");
    const data = mockExperiment.update.mock.calls[0][0].data;
    expect(data.sortOrder).toBe(4);
  });
});

// ─── reorderExperiment ────────────────────────────────────────────────────────

describe("reorderExperiment", () => {
  it("updates sort order directly", async () => {
    await reorderExperiment("exp-1", 5, "/path");
    expect(mockExperiment.update).toHaveBeenCalledWith({
      where: { id: "exp-1" },
      data: { sortOrder: 5 },
    });
  });
});
