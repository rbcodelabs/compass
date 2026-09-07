import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuth } = vi.hoisted(() => ({ mockAuth: vi.fn() }));

const mockRoadmapItem = {
  create: vi.fn(),
  update: vi.fn(),
  findFirst: vi.fn(),
  findUnique: vi.fn(),
};
const mockSolution = {
  findFirst: vi.fn(),
};
const mockFeedbackItem = {
  findFirst: vi.fn(),
};
const mockWorkspaceMember = { findUnique: vi.fn() };
const mockOpportunity = { findFirst: vi.fn() };
const mockSquad = { findFirst: vi.fn() };
const mockExperiment = { findFirst: vi.fn() };
const mockKeyResult = { findFirst: vi.fn() };

const mockPrisma = {
  roadmapItem: mockRoadmapItem,
  solution: mockSolution,
  feedbackItem: mockFeedbackItem,
  workspaceMember: mockWorkspaceMember,
  opportunity: mockOpportunity,
  squad: mockSquad,
  experiment: mockExperiment,
  keyResult: mockKeyResult,
  portfolioCapacityReservation: { findUnique: vi.fn(), update: vi.fn() },
  portfolioCapacityPlan: { updateMany: vi.fn() },
  $transaction: vi.fn(),
};

vi.mock("@/lib/db", () => ({
  default: vi.fn(() => mockPrisma),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import {
  addRoadmapItem,
  moveItem,
  archiveItem,
  promoteToRoadmap,
  promoteFeedbackToRoadmap,
  updateSortOrder,
  updateRoadmapItem,
  editRoadmapItem,
} from "@/app/[orgSlug]/[workspaceSlug]/roadmap/actions";

beforeEach(() => {
  vi.clearAllMocks();
  mockRoadmapItem.create.mockResolvedValue({ id: "item-1", title: "Test Item" });
  mockRoadmapItem.update.mockResolvedValue({ id: "item-1" });
  mockRoadmapItem.findFirst.mockImplementation(({ where }: { where: { id?: string } }) =>
    where.id
      ? Promise.resolve({ id: where.id, workspaceId: "ws-1", horizon: "NEXT", status: "ACTIVE" })
      : Promise.resolve(null),
  );
  mockRoadmapItem.findUnique.mockResolvedValue({ id: "item-1", horizon: "NEXT", status: "ACTIVE" });
  mockPrisma.portfolioCapacityReservation.findUnique.mockResolvedValue(null);
  mockPrisma.$transaction.mockImplementation((fn: (database: typeof mockPrisma) => unknown) => fn(mockPrisma));
  mockSolution.findFirst.mockResolvedValue({ id: "sol-1", title: "My Solution", opportunity: { id: "opp-1", squadId: null } });
  mockWorkspaceMember.findUnique.mockResolvedValue({ id: "member-1" });
  mockOpportunity.findFirst.mockResolvedValue({ id: "opp-1" });
  mockSquad.findFirst.mockResolvedValue({ id: "squad-1" });
  mockExperiment.findFirst.mockResolvedValue({ id: "exp-1" });
  mockKeyResult.findFirst.mockResolvedValue({ id: "kr-1" });
  mockAuth.mockResolvedValue({ user: { id: "user-1" } });
  mockFeedbackItem.findFirst.mockResolvedValue({ title: "Login button is broken" });
});

// ─── addRoadmapItem ───────────────────────────────────────────────────────────

describe("addRoadmapItem", () => {
  it("rejects a non-member before roadmap reads or writes", async () => {
    mockWorkspaceMember.findUnique.mockResolvedValue(null);
    await expect(addRoadmapItem("other-workspace", { title: "Forbidden", horizon: "NOW" })).rejects.toThrow("Workspace not found");
    expect(mockRoadmapItem.findFirst).not.toHaveBeenCalled();
    expect(mockRoadmapItem.create).not.toHaveBeenCalled();
  });
  it("creates an item at sortOrder 0 when column is empty", async () => {
    mockRoadmapItem.findFirst.mockResolvedValueOnce(null);
    const result = await addRoadmapItem(
      "ws-1",
      { title: "Ship payments", horizon: "NEXT" }
    );
    const data = mockRoadmapItem.create.mock.calls[0][0].data;
    expect(data.sortOrder).toBe(0);
    expect(data.horizon).toBe("NEXT");
    expect(data.title).toBe("Ship payments");
    expect(result).toMatchObject({ id: "item-1" });
  });

  it("places item after the last item in the horizon", async () => {
    mockRoadmapItem.findFirst.mockResolvedValue({ sortOrder: 4 });
    await addRoadmapItem("ws-1", { title: "Feature X", horizon: "NEXT" });
    const data = mockRoadmapItem.create.mock.calls[0][0].data;
    expect(data.sortOrder).toBe(5);
  });

  it("passes through optional solutionId", async () => {
    await addRoadmapItem(
      "ws-1",
      { title: "Feature Y", horizon: "LATER", solutionId: "sol-99" }
    );
    const data = mockRoadmapItem.create.mock.calls[0][0].data;
    expect(data.solutionId).toBe("sol-99");
  });

  it("passes through optional keyResultId", async () => {
    await addRoadmapItem(
      "ws-1",
      { title: "Feature Z", horizon: "NEXT", keyResultId: "kr-5" }
    );
    const data = mockRoadmapItem.create.mock.calls[0][0].data;
    expect(data.keyResultId).toBe("kr-5");
  });

  it("propagates DB errors", async () => {
    mockRoadmapItem.create.mockRejectedValue(new Error("DB error"));
    await expect(
      addRoadmapItem("ws-1", { title: "Fail", horizon: "NEXT" })
    ).rejects.toThrow("DB error");
  });

  it("passes through optional startDate and endDate", async () => {
    const startDate = new Date("2026-07-01");
    const endDate = new Date("2026-09-30");
    await addRoadmapItem(
      "ws-1",
      { title: "Timed feature", horizon: "NEXT", startDate, endDate }
    );
    const data = mockRoadmapItem.create.mock.calls[0][0].data;
    expect(data.startDate).toBe(startDate);
    expect(data.endDate).toBe(endDate);
  });

  it("defaults isPrivate to false when not provided", async () => {
    await addRoadmapItem("ws-1", { title: "Public by default", horizon: "NEXT" });
    const data = mockRoadmapItem.create.mock.calls[0][0].data;
    expect(data.isPrivate).toBe(false);
  });

  it("passes through isPrivate: true", async () => {
    await addRoadmapItem(
      "ws-1",
      { title: "Security fix", horizon: "NEXT", isPrivate: true }
    );
    const data = mockRoadmapItem.create.mock.calls[0][0].data;
    expect(data.isPrivate).toBe(true);
  });
});

// ─── moveItem ─────────────────────────────────────────────────────────────────

describe("moveItem", () => {
  it("rejects a non-member before item lookup or telemetry", async () => {
    mockWorkspaceMember.findUnique.mockResolvedValue(null);
    await expect(moveItem("item-1", "NOW", "other-workspace")).rejects.toThrow("Workspace not found");
    expect(mockRoadmapItem.findFirst).not.toHaveBeenCalled();
    expect(mockRoadmapItem.update).not.toHaveBeenCalled();
  });
  it("changes horizon and places at sortOrder 0 when destination empty", async () => {
    mockRoadmapItem.findFirst
      .mockResolvedValueOnce({ id: "item-1", workspaceId: "ws-1", horizon: "NEXT", status: "ACTIVE" })
      .mockResolvedValueOnce(null);
    await moveItem("item-1", "LATER", "ws-1");
    const data = mockRoadmapItem.update.mock.calls[0][0].data;
    expect(data.horizon).toBe("LATER");
    expect(data.sortOrder).toBe(0);
  });

  it("places item after last existing item in destination horizon", async () => {
    mockRoadmapItem.findFirst
      .mockResolvedValueOnce({ id: "item-1", workspaceId: "ws-1", horizon: "LATER", status: "ACTIVE" })
      .mockResolvedValueOnce({ sortOrder: 7 });
    await moveItem("item-1", "NEXT", "ws-1");
    const data = mockRoadmapItem.update.mock.calls[0][0].data;
    expect(data.sortOrder).toBe(8);
  });

  it("moves an item to the SHIPPED horizon", async () => {
    mockRoadmapItem.findFirst
      .mockResolvedValueOnce({ id: "item-1", workspaceId: "ws-1", horizon: "NEXT", status: "ACTIVE" })
      .mockResolvedValueOnce(null);
    await moveItem("item-1", "SHIPPED", "ws-1");
    const data = mockRoadmapItem.update.mock.calls[0][0].data;
    expect(data.horizon).toBe("SHIPPED");
  });
});

// ─── archiveItem ──────────────────────────────────────────────────────────────

describe("archiveItem", () => {
  it("sets status to ARCHIVED", async () => {
    await archiveItem("item-1", "ws-1");
    expect(mockRoadmapItem.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "item-1" },
      data: expect.objectContaining({ status: "ARCHIVED" }),
    }));
  });

  it("propagates DB errors", async () => {
    mockRoadmapItem.update.mockRejectedValue(new Error("not found"));
    await expect(archiveItem("item-999", "ws-1")).rejects.toThrow("not found");
  });
});

// ─── promoteToRoadmap ─────────────────────────────────────────────────────────

describe("promoteToRoadmap", () => {
  it("rejects a Solution outside the authorized workspace before roadmap mutation", async () => {
    mockSolution.findFirst.mockResolvedValue(null);
    await expect(promoteToRoadmap("foreign-solution", "ws-1", "NOW", null, null)).rejects.toThrow("Solution not found");
    expect(mockRoadmapItem.create).not.toHaveBeenCalled();
  });
  it("creates a roadmap item using the solution title", async () => {
    mockSolution.findFirst.mockResolvedValue({ title: "Great Solution", opportunity: { id: "opp-1", squadId: null } });
    const result = await promoteToRoadmap("sol-1", "ws-1", "NEXT", null, null);
    const data = mockRoadmapItem.create.mock.calls[0][0].data;
    expect(data.title).toBe("Great Solution");
    expect(data.solutionId).toBe("sol-1");
    expect(result).toMatchObject({ id: "item-1" });
  });

  it("throws when solution is not found", async () => {
    mockSolution.findFirst.mockResolvedValue(null);
    await expect(
      promoteToRoadmap("sol-999", "ws-1", "NEXT", null, null)
    ).rejects.toThrow("Solution not found");
  });

  it("places item at sortOrder 0 when horizon is empty", async () => {
    mockRoadmapItem.findFirst.mockResolvedValue(null);
    await promoteToRoadmap("sol-1", "ws-1", "NEXT", null, null);
    const data = mockRoadmapItem.create.mock.calls[0][0].data;
    expect(data.sortOrder).toBe(0);
  });

  it("places item after last item in horizon", async () => {
    mockRoadmapItem.findFirst.mockResolvedValue({ sortOrder: 2 });
    await promoteToRoadmap("sol-1", "ws-1", "LATER", null, null);
    const data = mockRoadmapItem.create.mock.calls[0][0].data;
    expect(data.sortOrder).toBe(3);
  });

  it("passes through squadId and opportunityId", async () => {
    mockSolution.findFirst.mockResolvedValue({ title: "My Solution", opportunity: { id: "opp-1", squadId: "squad-1" } });
    await promoteToRoadmap("sol-1", "ws-1", "NEXT", "squad-1", "opp-1");
    const data = mockRoadmapItem.create.mock.calls[0][0].data;
    expect(data.squadId).toBe("squad-1");
    expect(data.opportunityId).toBe("opp-1");
  });

  it("passes through optional dates when scheduled directly onto the timeline", async () => {
    const startDate = new Date("2026-07-01");
    const endDate = new Date("2026-09-30");
    await promoteToRoadmap("sol-1", "ws-1", "NEXT", null, null, { startDate, endDate });
    const data = mockRoadmapItem.create.mock.calls[0][0].data;
    expect(data.startDate).toBe(startDate);
    expect(data.endDate).toBe(endDate);
  });

  it("creates without dates when not scheduled with a timeframe", async () => {
    await promoteToRoadmap("sol-1", "ws-1", "NEXT", null, null);
    const data = mockRoadmapItem.create.mock.calls[0][0].data;
    expect(data.startDate).toBeUndefined();
    expect(data.endDate).toBeUndefined();
  });

  it("defaults isPrivate to false when not provided", async () => {
    await promoteToRoadmap("sol-1", "ws-1", "NEXT", null, null);
    const data = mockRoadmapItem.create.mock.calls[0][0].data;
    expect(data.isPrivate).toBe(false);
  });

  it("passes through isPrivate: true", async () => {
    await promoteToRoadmap("sol-1", "ws-1", "NEXT", null, null, undefined, true);
    const data = mockRoadmapItem.create.mock.calls[0][0].data;
    expect(data.isPrivate).toBe(true);
  });
});

// ─── promoteFeedbackToRoadmap ─────────────────────────────────────────────────

describe("promoteFeedbackToRoadmap", () => {
  it("rejects an unauthenticated caller without writing", async () => {
    mockAuth.mockResolvedValue(null);

    await expect(
      promoteFeedbackToRoadmap("fb-1", "ws-1", "NEXT")
    ).rejects.toThrow("Unauthorized");

    expect(mockFeedbackItem.findFirst).not.toHaveBeenCalled();
    expect(mockRoadmapItem.create).not.toHaveBeenCalled();
  });

  it("rejects a non-member without writing", async () => {
    mockWorkspaceMember.findUnique.mockResolvedValue(null);

    await expect(
      promoteFeedbackToRoadmap("fb-1", "ws-1", "NEXT")
    ).rejects.toThrow("Workspace not found");

    expect(mockFeedbackItem.findFirst).not.toHaveBeenCalled();
    expect(mockRoadmapItem.create).not.toHaveBeenCalled();
  });

  it("rejects feedback from another workspace without writing", async () => {
    mockFeedbackItem.findFirst.mockResolvedValue(null);

    await expect(
      promoteFeedbackToRoadmap("fb-other", "ws-1", "NEXT")
    ).rejects.toThrow("Feedback item not found");

    expect(mockFeedbackItem.findFirst).toHaveBeenCalledWith({
      where: { id: "fb-other", workspaceId: "ws-1" },
      select: { title: true },
    });
    expect(mockRoadmapItem.create).not.toHaveBeenCalled();
  });

  it("creates a roadmap item for an authorized same-workspace member", async () => {
    const result = await promoteFeedbackToRoadmap("fb-1", "ws-1", "NEXT");
    const data = mockRoadmapItem.create.mock.calls[0][0].data;
    expect(data.title).toBe("Login button is broken");
    expect(data.feedbackId).toBe("fb-1");
    expect(data.workspaceId).toBe("ws-1");
    expect(data.horizon).toBe("NEXT");
    expect(result).toMatchObject({ id: "item-1" });
  });

  it("uses the authorized workspace for roadmap creation", async () => {
    await promoteFeedbackToRoadmap("fb-1", "ws-authorized", "NEXT");

    expect(mockFeedbackItem.findFirst).toHaveBeenCalledWith({
      where: { id: "fb-1", workspaceId: "ws-authorized" },
      select: { title: true },
    });
    expect(mockRoadmapItem.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: "ws-authorized",
        feedbackId: "fb-1",
      }),
    });
  });

  it("throws when feedback item is not found", async () => {
    mockFeedbackItem.findFirst.mockResolvedValue(null);
    await expect(
      promoteFeedbackToRoadmap("fb-999", "ws-1", "NEXT")
    ).rejects.toThrow("Feedback item not found");
    expect(mockRoadmapItem.create).not.toHaveBeenCalled();
  });

  it("places item at sortOrder 0 when horizon is empty", async () => {
    mockRoadmapItem.findFirst.mockResolvedValue(null);
    await promoteFeedbackToRoadmap("fb-1", "ws-1", "NEXT");
    const data = mockRoadmapItem.create.mock.calls[0][0].data;
    expect(data.sortOrder).toBe(0);
  });

  it("places item after last item in horizon", async () => {
    mockRoadmapItem.findFirst.mockResolvedValue({ sortOrder: 3 });
    await promoteFeedbackToRoadmap("fb-1", "ws-1", "LATER");
    const data = mockRoadmapItem.create.mock.calls[0][0].data;
    expect(data.sortOrder).toBe(4);
  });

  it("revalidates the trusted application layout", async () => {
    const { revalidatePath } = await import("next/cache");
    await promoteFeedbackToRoadmap("fb-1", "ws-1", "NEXT");
    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
  });

  it("propagates DB errors", async () => {
    mockRoadmapItem.create.mockRejectedValue(new Error("DB error"));
    await expect(
      promoteFeedbackToRoadmap("fb-1", "ws-1", "NEXT")
    ).rejects.toThrow("DB error");
  });

  it("passes through optional dates when scheduled directly onto the timeline", async () => {
    const startDate = new Date("2026-08-01");
    const endDate = new Date("2026-08-15");
    await promoteFeedbackToRoadmap("fb-1", "ws-1", "NEXT", { startDate, endDate });
    const data = mockRoadmapItem.create.mock.calls[0][0].data;
    expect(data.startDate).toBe(startDate);
    expect(data.endDate).toBe(endDate);
  });

  it("creates without dates when not scheduled with a timeframe", async () => {
    await promoteFeedbackToRoadmap("fb-1", "ws-1", "NEXT");
    const data = mockRoadmapItem.create.mock.calls[0][0].data;
    expect(data.startDate).toBeUndefined();
    expect(data.endDate).toBeUndefined();
  });

  it("defaults isPrivate to false when not provided", async () => {
    await promoteFeedbackToRoadmap("fb-1", "ws-1", "NEXT");
    const data = mockRoadmapItem.create.mock.calls[0][0].data;
    expect(data.isPrivate).toBe(false);
  });

  it("passes through isPrivate: true (e.g. a security-flagged bug)", async () => {
    await promoteFeedbackToRoadmap("fb-1", "ws-1", "NEXT", undefined, true);
    const data = mockRoadmapItem.create.mock.calls[0][0].data;
    expect(data.isPrivate).toBe(true);
  });
});

// ─── updateSortOrder ──────────────────────────────────────────────────────────

describe("updateSortOrder", () => {
  it("updates the sort order directly", async () => {
    await updateSortOrder("item-1", "ws-1", 9);
    expect(mockRoadmapItem.update).toHaveBeenCalledWith({
      where: { id: "item-1" },
      data: { sortOrder: 9, updatedAt: expect.any(Date) },
    });
  });
});

// ─── updateRoadmapItem ────────────────────────────────────────────────────────

describe("updateRoadmapItem", () => {
  it("rejects a partial effective date range", async () => {
    mockRoadmapItem.findFirst.mockResolvedValueOnce({
      id: "item-1", workspaceId: "ws-1", horizon: "NEXT", status: "ACTIVE",
      startDate: null, endDate: null,
    });
    await expect(updateRoadmapItem("item-1", "ws-1", {
      startDate: new Date("2026-09-10T00:00:00.000Z"),
    })).rejects.toThrow(/inclusive range/);
    expect(mockRoadmapItem.update).not.toHaveBeenCalled();
  });

  it("rejects a reversed effective date range", async () => {
    mockRoadmapItem.findFirst.mockResolvedValueOnce({
      id: "item-1", workspaceId: "ws-1", horizon: "NEXT", status: "ACTIVE",
      startDate: new Date("2026-09-01T00:00:00.000Z"), endDate: new Date("2026-09-05T00:00:00.000Z"),
    });
    await expect(updateRoadmapItem("item-1", "ws-1", {
      startDate: new Date("2026-09-08T00:00:00.000Z"),
    })).rejects.toThrow(/inclusive range/);
    expect(mockRoadmapItem.update).not.toHaveBeenCalled();
  });

  it("allows clearing both dates", async () => {
    await updateRoadmapItem("item-1", "ws-1", { startDate: null, endDate: null });
    expect(mockRoadmapItem.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ startDate: null, endDate: null }),
    }));
  });

  it("updates only the provided fields and always sets updatedAt explicitly", async () => {
    const startDate = new Date("2026-08-01");
    const endDate = new Date("2026-08-15");
    await updateRoadmapItem(
      "item-1",
      "ws-1",
      { title: "Renamed", startDate, endDate }
    );
    const call = mockRoadmapItem.update.mock.calls[0][0];
    expect(call.where).toEqual({ id: "item-1" });
    expect(call.data.title).toBe("Renamed");
    expect(call.data.startDate).toBe(startDate);
    expect(call.data.endDate).toBe(endDate);
    expect(call.data.description).toBeUndefined();
    expect(call.data.updatedAt).toBeInstanceOf(Date);
  });

  it("leaves fields untouched when not provided (undefined) but clears when explicitly null", async () => {
    await updateRoadmapItem(
      "item-1",
      "ws-1",
      { description: "New description", startDate: null, endDate: null }
    );
    const call = mockRoadmapItem.update.mock.calls[0][0];
    expect(call.data.title).toBeUndefined();
    expect(call.data.description).toBe("New description");
    expect(call.data.startDate).toBeNull();
    expect(call.data.endDate).toBeNull();
  });

  it("propagates DB errors for a missing item id", async () => {
    mockRoadmapItem.update.mockRejectedValue(new Error("Record to update not found"));
    await expect(
      updateRoadmapItem("item-missing", "ws-1", { title: "X" })
    ).rejects.toThrow("Record to update not found");
  });

  it("leaves isPrivate untouched when not provided", async () => {
    await updateRoadmapItem("item-1", "ws-1", { title: "Renamed" });
    const call = mockRoadmapItem.update.mock.calls[0][0];
    expect(call.data.isPrivate).toBeUndefined();
  });

  it("sets isPrivate when explicitly provided", async () => {
    await updateRoadmapItem("item-1", "ws-1", { isPrivate: true });
    const call = mockRoadmapItem.update.mock.calls[0][0];
    expect(call.data.isPrivate).toBe(true);
  });

  it("can toggle isPrivate back to false", async () => {
    await updateRoadmapItem("item-1", "ws-1", { isPrivate: false });
    const call = mockRoadmapItem.update.mock.calls[0][0];
    expect(call.data.isPrivate).toBe(false);
  });
});

// ─── editRoadmapItem ─────────────────────────────────────────────────────────

describe("editRoadmapItem", () => {
  const editData = {
    title: "Renamed",
    description: "Updated description",
    startDate: null,
    endDate: null,
    isPrivate: true,
    opportunityId: "opp-2",
  };

  beforeEach(() => {
    mockRoadmapItem.findFirst.mockResolvedValue({
      id: "item-1",
      startDate: null,
      endDate: null,
      opportunityId: "opp-1",
      opportunity: { id: "opp-1", title: "Existing" },
    });
    mockRoadmapItem.update.mockResolvedValue({
      id: "item-1",
      title: "Renamed",
      description: "Updated description",
      startDate: null,
      endDate: null,
      isPrivate: true,
      opportunityId: "opp-2",
    });
    mockOpportunity.findFirst.mockResolvedValue({ id: "opp-2", title: "Retention friction" });
  });

  it("rejects an unauthenticated caller before querying roadmap data", async () => {
    mockAuth.mockResolvedValue(null);

    await expect(editRoadmapItem("item-1", "ws-1", editData)).rejects.toThrow("Unauthorized");

    expect(mockWorkspaceMember.findUnique).not.toHaveBeenCalled();
    expect(mockRoadmapItem.findFirst).not.toHaveBeenCalled();
    expect(mockRoadmapItem.update).not.toHaveBeenCalled();
  });

  it("rejects a non-member before querying roadmap data", async () => {
    mockWorkspaceMember.findUnique.mockResolvedValue(null);

    await expect(editRoadmapItem("item-1", "ws-1", editData)).rejects.toThrow("Workspace not found");

    expect(mockRoadmapItem.findFirst).not.toHaveBeenCalled();
    expect(mockRoadmapItem.update).not.toHaveBeenCalled();
  });

  it("does not reveal an item from another workspace", async () => {
    mockRoadmapItem.findFirst.mockResolvedValue(null);

    await expect(editRoadmapItem("item-secret", "ws-1", editData)).rejects.toThrow("Roadmap item not found");

    expect(mockRoadmapItem.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "item-secret", workspaceId: "ws-1" },
    }));
    expect(mockRoadmapItem.update).not.toHaveBeenCalled();
  });

  it.each(["opp-missing", "opp-foreign"])(
    "rejects unavailable opportunity %s without committing scalar edits",
    async (opportunityId) => {
      mockOpportunity.findFirst.mockResolvedValue(null);

      await expect(
        editRoadmapItem("item-1", "ws-1", { ...editData, opportunityId }),
      ).rejects.toThrow("Opportunity not found");

      expect(mockOpportunity.findFirst).toHaveBeenCalledWith({
        where: { id: opportunityId, workspaceId: "ws-1" },
        select: { id: true, title: true },
      });
      expect(mockRoadmapItem.update).not.toHaveBeenCalled();
    },
  );

  it("atomically updates scalar fields and the opportunity relation", async () => {
    const result = await editRoadmapItem("item-1", "ws-1", editData);

    const call = mockRoadmapItem.update.mock.calls[0][0];
    expect(call.where).toEqual({ id: "item-1" });
    expect(call.data).toMatchObject({
      title: "Renamed",
      description: "Updated description",
      isPrivate: true,
      opportunityId: "opp-2",
      updatedAt: expect.any(Date),
    });
    expect(call.data).not.toHaveProperty("solutionId");
    expect(call.data).not.toHaveProperty("experimentId");
    expect(call.data).not.toHaveProperty("keyResultId");
    expect(call.data).not.toHaveProperty("feedbackId");
    expect(result).toMatchObject({
      opportunityId: "opp-2",
      opportunity: { id: "opp-2", title: "Retention friction" },
    });
  });

  it("clears an opportunity without looking it up", async () => {
    mockRoadmapItem.update.mockResolvedValue({
      id: "item-1",
      title: "Renamed",
      description: "Updated description",
      startDate: null,
      endDate: null,
      isPrivate: true,
      opportunityId: null,
    });

    const result = await editRoadmapItem("item-1", "ws-1", { ...editData, opportunityId: null });

    expect(mockOpportunity.findFirst).not.toHaveBeenCalled();
    expect(mockRoadmapItem.update.mock.calls[0][0].data).toMatchObject({ opportunityId: null });
    expect(result).toMatchObject({ opportunityId: null, opportunity: null });
  });

  it("preserves an archived current opportunity without a redundant lookup or relation write", async () => {
    const currentOpportunity = { id: "opp-archived", title: "Archived opportunity" };
    mockRoadmapItem.findFirst.mockResolvedValue({
      id: "item-1",
      startDate: null,
      endDate: null,
      opportunityId: currentOpportunity.id,
      opportunity: currentOpportunity,
    });

    const result = await editRoadmapItem("item-1", "ws-1", {
      ...editData,
      opportunityId: currentOpportunity.id,
    });

    expect(mockOpportunity.findFirst).not.toHaveBeenCalled();
    expect(mockRoadmapItem.update.mock.calls[0][0].data).not.toHaveProperty("opportunityId");
    expect(result.opportunity).toEqual(currentOpportunity);
  });
});
