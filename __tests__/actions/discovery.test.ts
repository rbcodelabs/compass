import { describe, it, expect, vi, beforeEach } from "vitest";

// Membership/foreign-entity denial uses real helpers in product-analytics-auth.test.ts.
vi.mock("@/lib/product-action-auth", () => ({
  requireProductWorkspace: vi.fn().mockResolvedValue("ws-1"),
  requireProductEntity: vi.fn().mockResolvedValue({ workspaceId: "ws-1", opportunityId: "opp-1" }),
}));

// Build a mock prisma object with all needed models.
// getPrisma() is a synchronous default export, so we mock the factory.
const mockOpportunity = {
  create: vi.fn(),
  update: vi.fn(),
  findFirst: vi.fn(),
  delete: vi.fn(),
};
const mockSolution = {
  create: vi.fn(),
  update: vi.fn(),
  findFirst: vi.fn(),
};
const mockAssumption = {
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
const mockWorkspace = { findFirst: vi.fn() };
const mockWorkspaceScoringConfig = { findUnique: vi.fn() };
const mockOpportunityScore = { upsert: vi.fn() };
const mockSolutionScore = { upsert: vi.fn() };

const mockPrisma = {
  opportunity: mockOpportunity,
  solution: mockSolution,
  assumption: mockAssumption,
  workspace: mockWorkspace,
  workspaceScoringConfig: mockWorkspaceScoringConfig,
  opportunityScore: mockOpportunityScore,
  solutionScore: mockSolutionScore,
  squad: { findFirst: vi.fn().mockResolvedValue({ id: "squad-1" }) },
};
// createOpportunity writes the opportunity and its links in one transaction.
const mockTransaction = vi.fn(async (callback: (tx: typeof mockPrisma) => Promise<unknown>) => callback(mockPrisma));
Object.assign(mockPrisma, { $transaction: mockTransaction });

vi.mock("@/lib/db", () => ({
  default: vi.fn(() => mockPrisma),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

vi.mock("@/auth", () => ({
  auth: vi.fn(),
}));

import { auth } from "@/auth";
import {
  createOpportunity,
  updateOpportunityStatus,
  addSolution,
  updateSolutionStatus,
  addAssumption,
  updateAssumptionStatus,
  linkOpportunityToKeyResult,
  archiveOpportunity,
  archiveSolution,
  deleteAssumption,
  moveOpportunity,
  reorderOpportunity,
  reorderSolution,
  reorderAssumption,
  saveOpportunityScore,
  saveSolutionScore,
  moveSolutionStatus,
} from "@/app/[orgSlug]/[workspaceSlug]/discovery/actions";

const mockAuth = vi.mocked(auth);

beforeEach(() => {
  vi.clearAllMocks();
  mockOpportunity.create.mockResolvedValue({ id: "opp-1", title: "Test Opp" });
  mockOpportunity.update.mockResolvedValue({ id: "opp-1", status: "VALIDATING" });
  mockOpportunity.findFirst.mockResolvedValue(null); // no last item by default
  mockSolution.create.mockResolvedValue({ id: "sol-1", title: "Test Sol" });
  mockSolution.update.mockResolvedValue({ id: "sol-1" });
  mockSolution.findFirst.mockResolvedValue(null); // no last item by default
  mockAssumption.create.mockResolvedValue({ id: "ass-1", title: "Test Assumption" });
  mockAssumption.update.mockResolvedValue({ id: "ass-1" });
  mockAssumption.delete.mockResolvedValue({ id: "ass-1" });
  mockAuth.mockResolvedValue({ user: { id: "user-1" } } as ReturnType<typeof auth> extends Promise<infer T>
    ? T
    : never);
  mockWorkspace.findFirst.mockResolvedValue({ id: "ws-1" });
  mockWorkspaceScoringConfig.findUnique.mockResolvedValue(null);
  mockOpportunityScore.upsert.mockResolvedValue({ id: "score-1" });
  mockSolutionScore.upsert.mockResolvedValue({ id: "sol-score-1" });
});

// ─── createOpportunity ───────────────────────────────────────────────────────

describe("createOpportunity", () => {
  it("creates an opportunity with default status EXPLORING", async () => {
    const result = await createOpportunity("ws-1", { title: "Improve onboarding" });
    expect(mockOpportunity.create).toHaveBeenCalledOnce();
    const callArgs = mockOpportunity.create.mock.calls[0][0].data;
    expect(callArgs.status).toBe("EXPLORING");
    expect(callArgs.title).toBe("Improve onboarding");
    expect(result).toEqual({ id: "opp-1", title: "Test Opp" });
  });

  it("passes through a custom status", async () => {
    await createOpportunity("ws-1", { title: "Feature X", status: "VALIDATING" });
    const callArgs = mockOpportunity.create.mock.calls[0][0].data;
    expect(callArgs.status).toBe("VALIDATING");
  });

  it("sets squadId to null when not provided", async () => {
    await createOpportunity("ws-1", { title: "Feature Y" });
    const callArgs = mockOpportunity.create.mock.calls[0][0].data;
    expect(callArgs.squadId).toBeNull();
  });

  it("propagates DB errors", async () => {
    mockOpportunity.create.mockRejectedValue(new Error("DB down"));
    await expect(
      createOpportunity("ws-1", { title: "Feature Z" })
    ).rejects.toThrow("DB down");
  });
});

// ─── updateOpportunityStatus ─────────────────────────────────────────────────

describe("updateOpportunityStatus", () => {
  it("updates the status field", async () => {
    await updateOpportunityStatus("opp-1", "PRIORITIZED", "/org/ws/discovery");
    expect(mockOpportunity.update).toHaveBeenCalledWith({
      where: { id: "opp-1" },
      data: { status: "PRIORITIZED" },
    });
  });

  it("propagates DB errors", async () => {
    mockOpportunity.update.mockRejectedValue(new Error("Constraint violation"));
    await expect(
      updateOpportunityStatus("opp-1", "ACTIVE", "/path")
    ).rejects.toThrow("Constraint violation");
  });
});

// ─── addSolution ─────────────────────────────────────────────────────────────

describe("addSolution", () => {
  it("creates a solution linked to the opportunity", async () => {
    const result = await addSolution("opp-1", { title: "New Solution" }, "/path");
    expect(mockSolution.create).toHaveBeenCalledWith({
      data: { opportunityId: "opp-1", title: "New Solution", description: undefined },
    });
    expect(result).toEqual({ id: "sol-1", title: "Test Sol" });
  });

  it("passes through description when provided", async () => {
    await addSolution("opp-1", { title: "Sol B", description: "Details" }, "/path");
    const callArgs = mockSolution.create.mock.calls[0][0].data;
    expect(callArgs.description).toBe("Details");
  });
});

// ─── updateSolutionStatus ─────────────────────────────────────────────────────

describe("updateSolutionStatus", () => {
  it("updates the solution status", async () => {
    await updateSolutionStatus("sol-1", "VALIDATED", "/path");
    expect(mockSolution.update).toHaveBeenCalledWith({
      where: { id: "sol-1" },
      data: { status: "VALIDATED" },
    });
  });
});

// ─── addAssumption ────────────────────────────────────────────────────────────

describe("addAssumption", () => {
  it("creates an assumption with riskLevel", async () => {
    await addAssumption("sol-1", { title: "Users will adopt it", riskLevel: "HIGH" }, "/path");
    expect(mockAssumption.create).toHaveBeenCalledWith({
      data: { solutionId: "sol-1", title: "Users will adopt it", riskLevel: "HIGH" },
    });
  });
});

// ─── updateAssumptionStatus ───────────────────────────────────────────────────

describe("updateAssumptionStatus", () => {
  it("updates the assumption status to VALIDATED", async () => {
    await updateAssumptionStatus("ass-1", "VALIDATED", "/path");
    expect(mockAssumption.update).toHaveBeenCalledWith({
      where: { id: "ass-1" },
      data: { status: "VALIDATED" },
    });
  });

  it("updates the assumption status to INVALIDATED", async () => {
    await updateAssumptionStatus("ass-1", "INVALIDATED", "/path");
    const callArgs = mockAssumption.update.mock.calls[0][0].data;
    expect(callArgs.status).toBe("INVALIDATED");
  });
});

// ─── linkOpportunityToKeyResult ───────────────────────────────────────────────

describe("linkOpportunityToKeyResult", () => {
  it("links an opportunity to a key result", async () => {
    await linkOpportunityToKeyResult("opp-1", "kr-1", "/path");
    expect(mockOpportunity.update).toHaveBeenCalledWith({
      where: { id: "opp-1" },
      data: { linkedKeyResultId: "kr-1" },
    });
  });

  it("clears the link when null is passed", async () => {
    await linkOpportunityToKeyResult("opp-1", null, "/path");
    const callArgs = mockOpportunity.update.mock.calls[0][0].data;
    expect(callArgs.linkedKeyResultId).toBeNull();
  });
});

// ─── archiveOpportunity ───────────────────────────────────────────────────────

describe("archiveOpportunity", () => {
  it("sets status to ARCHIVED", async () => {
    await archiveOpportunity("opp-1", "/path");
    expect(mockOpportunity.update).toHaveBeenCalledWith({
      where: { id: "opp-1" },
      data: { status: "ARCHIVED" },
    });
  });
});

// ─── archiveSolution ──────────────────────────────────────────────────────────

describe("archiveSolution", () => {
  it("sets status to KILLED", async () => {
    await archiveSolution("sol-1", "/path");
    expect(mockSolution.update).toHaveBeenCalledWith({
      where: { id: "sol-1" },
      data: { status: "KILLED" },
    });
  });
});

// ─── deleteAssumption ─────────────────────────────────────────────────────────

describe("deleteAssumption", () => {
  it("deletes the assumption by id", async () => {
    await deleteAssumption("ass-1", "/path");
    expect(mockAssumption.delete).toHaveBeenCalledWith({ where: { id: "ass-1" } });
  });
});

// ─── moveOpportunity ─────────────────────────────────────────────────────────

describe("moveOpportunity", () => {
  it("places item at sortOrder 0 when no existing items in destination", async () => {
    mockOpportunity.findFirst.mockResolvedValue(null);
    await moveOpportunity("opp-1", "VALIDATING", "ws-1", "/path");
    const updateCall = mockOpportunity.update.mock.calls[0][0];
    expect(updateCall.data.sortOrder).toBe(0);
    expect(updateCall.data.status).toBe("VALIDATING");
  });

  it("places item after the last item in destination column", async () => {
    mockOpportunity.findFirst.mockResolvedValue({ sortOrder: 5 });
    await moveOpportunity("opp-1", "ACTIVE", "ws-1", "/path");
    const updateCall = mockOpportunity.update.mock.calls[0][0];
    expect(updateCall.data.sortOrder).toBe(6);
  });
});

// ─── reorderOpportunity ───────────────────────────────────────────────────────

describe("reorderOpportunity", () => {
  it("updates the sort order directly", async () => {
    await reorderOpportunity("opp-1", 3, "/path");
    expect(mockOpportunity.update).toHaveBeenCalledWith({
      where: { id: "opp-1" },
      data: { sortOrder: 3 },
    });
  });
});

// ─── reorderSolution ──────────────────────────────────────────────────────────

describe("reorderSolution", () => {
  it("updates the sort order directly", async () => {
    await reorderSolution("sol-1", 2, "/path");
    expect(mockSolution.update).toHaveBeenCalledWith({
      where: { id: "sol-1" },
      data: { sortOrder: 2 },
    });
  });
});

// ─── reorderAssumption ────────────────────────────────────────────────────────

describe("reorderAssumption", () => {
  it("updates the sort order directly", async () => {
    await reorderAssumption("ass-1", 1, "/path");
    expect(mockAssumption.update).toHaveBeenCalledWith({
      where: { id: "ass-1" },
      data: { sortOrder: 1 },
    });
  });
});

// ─── moveSolutionStatus ───────────────────────────────────────────────────────

describe("moveSolutionStatus", () => {
  it("places item at sortOrder 0 when no existing items in destination", async () => {
    mockSolution.findFirst.mockResolvedValue(null);
    await moveSolutionStatus("sol-1", "VALIDATED", "opp-1", "ws-1", "/path");
    const updateCall = mockSolution.update.mock.calls[0][0];
    expect(updateCall.where).toEqual({ id: "sol-1" });
    expect(updateCall.data.sortOrder).toBe(0);
    expect(updateCall.data.status).toBe("VALIDATED");
  });

  it("places item after the last item in the destination status within the same opportunity", async () => {
    mockSolution.findFirst.mockResolvedValue({ sortOrder: 5 });
    await moveSolutionStatus("sol-1", "IN_DELIVERY", "opp-1", "ws-1", "/path");
    const updateCall = mockSolution.update.mock.calls[0][0];
    expect(updateCall.data.sortOrder).toBe(6);
  });

  it("scopes the last-item lookup to the given opportunity and status, not just the workspace", async () => {
    await moveSolutionStatus("sol-1", "VALIDATED", "opp-1", "ws-1", "/path");
    expect(mockSolution.findFirst).toHaveBeenCalledWith({
      where: { opportunityId: "opp-1", status: "VALIDATED", NOT: { id: "sol-1" } },
      orderBy: { sortOrder: "desc" },
      select: { sortOrder: true },
    });
  });

  it("never touches opportunityId — reparenting is not exposed via this action", async () => {
    await moveSolutionStatus("sol-1", "VALIDATED", "opp-1", "ws-1", "/path");
    const updateCall = mockSolution.update.mock.calls[0][0];
    expect(updateCall.data.opportunityId).toBeUndefined();
  });
});

// ─── saveOpportunityScore ───────────────────────────────────────────────────────

describe("saveOpportunityScore", () => {
  const weightedSumModel = {
    id: "model-1",
    formulaType: "WEIGHTED_SUM",
    version: 2,
    metrics: [
      { key: "reach", label: "Reach", minValue: 0, maxValue: 10, weight: 1, direction: "POSITIVE" },
      { key: "effort", label: "Effort", minValue: 0, maxValue: 10, weight: 1, direction: "NEGATIVE" },
    ],
  };

  beforeEach(() => {
    mockOpportunity.findFirst.mockResolvedValue({ id: "opp-1" });
    mockWorkspaceScoringConfig.findUnique.mockResolvedValue({
      opportunityScoringModel: weightedSumModel,
    });
  });

  it("computes and upserts a score for valid raw values", async () => {
    const result = await saveOpportunityScore(
      "org",
      "ws",
      "opp-1",
      { reach: 8, effort: 2 },
      "/path"
    );

    expect(result.rawScore).toBe(6); // 8 - 2
    expect(mockOpportunityScore.upsert).toHaveBeenCalledWith({
      where: { opportunityId: "opp-1" },
      create: expect.objectContaining({
        opportunityId: "opp-1",
        scoringModelId: "model-1",
        modelVersion: 2,
        rawScore: 6,
        scoredByUserId: "user-1",
      }),
      update: expect.objectContaining({
        scoringModelId: "model-1",
        modelVersion: 2,
        rawScore: 6,
        scoredByUserId: "user-1",
        updatedAt: expect.any(Date),
      }),
    });
  });

  it("snapshots the formula definitions at save time", async () => {
    await saveOpportunityScore("org", "ws", "opp-1", { reach: 5, effort: 1 }, "/path");

    const createArg = mockOpportunityScore.upsert.mock.calls[0][0].create;
    expect(createArg.formulaSnapshot).toEqual([
      { key: "reach", label: "Reach", minValue: 0, maxValue: 10, weight: 1, direction: "POSITIVE" },
      { key: "effort", label: "Effort", minValue: 0, maxValue: 10, weight: 1, direction: "NEGATIVE" },
    ]);
  });

  it("throws Opportunity not found when it doesn't belong to this workspace", async () => {
    mockOpportunity.findFirst.mockResolvedValue(null);
    await expect(
      saveOpportunityScore("org", "ws", "opp-1", { reach: 5, effort: 1 }, "/path")
    ).rejects.toThrow("Opportunity not found");
    expect(mockOpportunityScore.upsert).not.toHaveBeenCalled();
  });

  it("throws when the workspace has no active scoring model", async () => {
    mockWorkspaceScoringConfig.findUnique.mockResolvedValue(null);
    await expect(
      saveOpportunityScore("org", "ws", "opp-1", { reach: 5, effort: 1 }, "/path")
    ).rejects.toThrow("no active scoring model");
    expect(mockOpportunityScore.upsert).not.toHaveBeenCalled();
  });

  it("throws when a required metric value is missing", async () => {
    await expect(
      saveOpportunityScore("org", "ws", "opp-1", { reach: 5 }, "/path")
    ).rejects.toThrow('Missing value for metric "effort"');
    expect(mockOpportunityScore.upsert).not.toHaveBeenCalled();
  });

  it("throws when a value is outside the metric's bounds", async () => {
    await expect(
      saveOpportunityScore("org", "ws", "opp-1", { reach: 50, effort: 1 }, "/path")
    ).rejects.toThrow('Value for "reach" must be between 0 and 10');
    expect(mockOpportunityScore.upsert).not.toHaveBeenCalled();
  });

  it("throws Unauthorized when session is missing", async () => {
    mockAuth.mockResolvedValue(null as never);
    await expect(
      saveOpportunityScore("org", "ws", "opp-1", { reach: 5, effort: 1 }, "/path")
    ).rejects.toThrow("Unauthorized");
  });

  it("throws Workspace not found when caller is not a member", async () => {
    mockWorkspace.findFirst.mockResolvedValue(null);
    await expect(
      saveOpportunityScore("org", "ws", "opp-1", { reach: 5, effort: 1 }, "/path")
    ).rejects.toThrow("Workspace not found");
  });
});

// ─── saveSolutionScore ──────────────────────────────────────────────────────────
// Structural mirror of the saveOpportunityScore suite above, resolving the
// workspace's independent Solution scoring slot instead.

describe("saveSolutionScore", () => {
  const weightedSumModel = {
    id: "model-1",
    formulaType: "WEIGHTED_SUM",
    version: 2,
    metrics: [
      { key: "reach", label: "Reach", minValue: 0, maxValue: 10, weight: 1, direction: "POSITIVE" },
      { key: "effort", label: "Effort", minValue: 0, maxValue: 10, weight: 1, direction: "NEGATIVE" },
    ],
  };

  beforeEach(() => {
    mockSolution.findFirst.mockResolvedValue({ id: "sol-1" });
    mockWorkspaceScoringConfig.findUnique.mockResolvedValue({
      solutionScoringModel: weightedSumModel,
    });
  });

  it("computes and upserts a score for valid raw values", async () => {
    const result = await saveSolutionScore(
      "org",
      "ws",
      "sol-1",
      { reach: 8, effort: 2 },
      "/path"
    );

    expect(result.rawScore).toBe(6); // 8 - 2
    expect(mockSolutionScore.upsert).toHaveBeenCalledWith({
      where: { solutionId: "sol-1" },
      create: expect.objectContaining({
        solutionId: "sol-1",
        scoringModelId: "model-1",
        modelVersion: 2,
        rawScore: 6,
        scoredByUserId: "user-1",
      }),
      update: expect.objectContaining({
        scoringModelId: "model-1",
        modelVersion: 2,
        rawScore: 6,
        scoredByUserId: "user-1",
        updatedAt: expect.any(Date),
      }),
    });
  });

  it("throws Solution not found when it doesn't belong to this workspace", async () => {
    mockSolution.findFirst.mockResolvedValue(null);
    await expect(
      saveSolutionScore("org", "ws", "sol-1", { reach: 5, effort: 1 }, "/path")
    ).rejects.toThrow("Solution not found");
    expect(mockSolutionScore.upsert).not.toHaveBeenCalled();
  });

  it("throws when the workspace has no active Solution scoring model", async () => {
    mockWorkspaceScoringConfig.findUnique.mockResolvedValue(null);
    await expect(
      saveSolutionScore("org", "ws", "sol-1", { reach: 5, effort: 1 }, "/path")
    ).rejects.toThrow("no active Solution scoring model");
    expect(mockSolutionScore.upsert).not.toHaveBeenCalled();
  });

  it("throws when a required metric value is missing", async () => {
    await expect(
      saveSolutionScore("org", "ws", "sol-1", { reach: 5 }, "/path")
    ).rejects.toThrow('Missing value for metric "effort"');
    expect(mockSolutionScore.upsert).not.toHaveBeenCalled();
  });

  it("throws when a value is outside the metric's bounds", async () => {
    await expect(
      saveSolutionScore("org", "ws", "sol-1", { reach: 50, effort: 1 }, "/path")
    ).rejects.toThrow('Value for "reach" must be between 0 and 10');
    expect(mockSolutionScore.upsert).not.toHaveBeenCalled();
  });
});
