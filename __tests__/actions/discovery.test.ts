import { describe, it, expect, vi, beforeEach } from "vitest";

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
};
const mockAssumption = {
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};

const mockPrisma = {
  opportunity: mockOpportunity,
  solution: mockSolution,
  assumption: mockAssumption,
};

vi.mock("@/lib/db", () => ({
  default: vi.fn(() => mockPrisma),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

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
} from "@/app/[orgSlug]/[workspaceSlug]/discovery/actions";

beforeEach(() => {
  vi.clearAllMocks();
  mockOpportunity.create.mockResolvedValue({ id: "opp-1", title: "Test Opp" });
  mockOpportunity.update.mockResolvedValue({ id: "opp-1", status: "VALIDATING" });
  mockOpportunity.findFirst.mockResolvedValue(null); // no last item by default
  mockSolution.create.mockResolvedValue({ id: "sol-1", title: "Test Sol" });
  mockSolution.update.mockResolvedValue({ id: "sol-1" });
  mockAssumption.create.mockResolvedValue({ id: "ass-1", title: "Test Assumption" });
  mockAssumption.update.mockResolvedValue({ id: "ass-1" });
  mockAssumption.delete.mockResolvedValue({ id: "ass-1" });
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
