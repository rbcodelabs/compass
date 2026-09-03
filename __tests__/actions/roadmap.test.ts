import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuth } = vi.hoisted(() => ({ mockAuth: vi.fn() }));

const mockRoadmapItem = {
  create: vi.fn(),
  update: vi.fn(),
  findFirst: vi.fn(),
  findUnique: vi.fn(),
};
const mockSolution = {
  findUnique: vi.fn(),
};
const mockFeedbackItem = {
  findFirst: vi.fn(),
};

const mockPrisma = {
  roadmapItem: mockRoadmapItem,
  solution: mockSolution,
  feedbackItem: mockFeedbackItem,
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
} from "@/app/[orgSlug]/[workspaceSlug]/roadmap/actions";

beforeEach(() => {
  vi.clearAllMocks();
  mockRoadmapItem.create.mockResolvedValue({ id: "item-1", title: "Test Item" });
  mockRoadmapItem.update.mockResolvedValue({ id: "item-1" });
  mockRoadmapItem.findFirst.mockResolvedValue(null);
  mockRoadmapItem.findUnique.mockResolvedValue({ id: "item-1", horizon: "NEXT", status: "ACTIVE" });
  mockPrisma.portfolioCapacityReservation.findUnique.mockResolvedValue(null);
  mockPrisma.$transaction.mockImplementation((fn: (database: typeof mockPrisma) => unknown) => fn(mockPrisma));
  mockSolution.findUnique.mockResolvedValue({ title: "My Solution" });
  mockAuth.mockResolvedValue({ user: { id: "user-1" } });
  mockFeedbackItem.findFirst.mockResolvedValue({ title: "Login button is broken" });
});

// ─── addRoadmapItem ───────────────────────────────────────────────────────────

describe("addRoadmapItem", () => {
  it("creates an item at sortOrder 0 when column is empty", async () => {
    mockRoadmapItem.findFirst.mockResolvedValue(null);
    const result = await addRoadmapItem(
      "ws-1",
      { title: "Ship payments", horizon: "NEXT" },
      "/path"
    );
    const data = mockRoadmapItem.create.mock.calls[0][0].data;
    expect(data.sortOrder).toBe(0);
    expect(data.horizon).toBe("NEXT");
    expect(data.title).toBe("Ship payments");
    expect(result).toMatchObject({ id: "item-1" });
  });

  it("places item after the last item in the horizon", async () => {
    mockRoadmapItem.findFirst.mockResolvedValue({ sortOrder: 4 });
    await addRoadmapItem("ws-1", { title: "Feature X", horizon: "NEXT" }, "/path");
    const data = mockRoadmapItem.create.mock.calls[0][0].data;
    expect(data.sortOrder).toBe(5);
  });

  it("passes through optional solutionId", async () => {
    await addRoadmapItem(
      "ws-1",
      { title: "Feature Y", horizon: "LATER", solutionId: "sol-99" },
      "/path"
    );
    const data = mockRoadmapItem.create.mock.calls[0][0].data;
    expect(data.solutionId).toBe("sol-99");
  });

  it("passes through optional keyResultId", async () => {
    await addRoadmapItem(
      "ws-1",
      { title: "Feature Z", horizon: "NEXT", keyResultId: "kr-5" },
      "/path"
    );
    const data = mockRoadmapItem.create.mock.calls[0][0].data;
    expect(data.keyResultId).toBe("kr-5");
  });

  it("propagates DB errors", async () => {
    mockRoadmapItem.create.mockRejectedValue(new Error("DB error"));
    await expect(
      addRoadmapItem("ws-1", { title: "Fail", horizon: "NEXT" }, "/path")
    ).rejects.toThrow("DB error");
  });

  it("passes through optional startDate and endDate", async () => {
    const startDate = new Date("2026-07-01");
    const endDate = new Date("2026-09-30");
    await addRoadmapItem(
      "ws-1",
      { title: "Timed feature", horizon: "NEXT", startDate, endDate },
      "/path"
    );
    const data = mockRoadmapItem.create.mock.calls[0][0].data;
    expect(data.startDate).toBe(startDate);
    expect(data.endDate).toBe(endDate);
  });

  it("defaults isPrivate to false when not provided", async () => {
    await addRoadmapItem("ws-1", { title: "Public by default", horizon: "NEXT" }, "/path");
    const data = mockRoadmapItem.create.mock.calls[0][0].data;
    expect(data.isPrivate).toBe(false);
  });

  it("passes through isPrivate: true", async () => {
    await addRoadmapItem(
      "ws-1",
      { title: "Security fix", horizon: "NEXT", isPrivate: true },
      "/path"
    );
    const data = mockRoadmapItem.create.mock.calls[0][0].data;
    expect(data.isPrivate).toBe(true);
  });
});

// ─── moveItem ─────────────────────────────────────────────────────────────────

describe("moveItem", () => {
  it("changes horizon and places at sortOrder 0 when destination empty", async () => {
    mockRoadmapItem.findFirst.mockResolvedValue(null);
    await moveItem("item-1", "LATER", "ws-1", "/path");
    const data = mockRoadmapItem.update.mock.calls[0][0].data;
    expect(data.horizon).toBe("LATER");
    expect(data.sortOrder).toBe(0);
  });

  it("places item after last existing item in destination horizon", async () => {
    mockRoadmapItem.findFirst.mockResolvedValue({ sortOrder: 7 });
    await moveItem("item-1", "NEXT", "ws-1", "/path");
    const data = mockRoadmapItem.update.mock.calls[0][0].data;
    expect(data.sortOrder).toBe(8);
  });

  it("moves an item to the SHIPPED horizon", async () => {
    mockRoadmapItem.findFirst.mockResolvedValue(null);
    await moveItem("item-1", "SHIPPED", "ws-1", "/path");
    const data = mockRoadmapItem.update.mock.calls[0][0].data;
    expect(data.horizon).toBe("SHIPPED");
  });
});

// ─── archiveItem ──────────────────────────────────────────────────────────────

describe("archiveItem", () => {
  it("sets status to ARCHIVED", async () => {
    await archiveItem("item-1", "/path");
    expect(mockRoadmapItem.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "item-1" },
      data: expect.objectContaining({ status: "ARCHIVED" }),
    }));
  });

  it("propagates DB errors", async () => {
    mockRoadmapItem.update.mockRejectedValue(new Error("not found"));
    await expect(archiveItem("item-999", "/path")).rejects.toThrow("not found");
  });
});

// ─── promoteToRoadmap ─────────────────────────────────────────────────────────

describe("promoteToRoadmap", () => {
  it("creates a roadmap item using the solution title", async () => {
    mockSolution.findUnique.mockResolvedValue({ title: "Great Solution" });
    const result = await promoteToRoadmap("sol-1", "ws-1", "NEXT", null, null);
    const data = mockRoadmapItem.create.mock.calls[0][0].data;
    expect(data.title).toBe("Great Solution");
    expect(data.solutionId).toBe("sol-1");
    expect(result).toMatchObject({ id: "item-1" });
  });

  it("throws when solution is not found", async () => {
    mockSolution.findUnique.mockResolvedValue(null);
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
      promoteFeedbackToRoadmap("fb-1", "ws-1", "NEXT", "/path")
    ).rejects.toThrow("Unauthorized");

    expect(mockFeedbackItem.findFirst).not.toHaveBeenCalled();
    expect(mockRoadmapItem.create).not.toHaveBeenCalled();
  });

  it("rejects a non-member without writing", async () => {
    mockFeedbackItem.findFirst.mockResolvedValue(null);

    await expect(
      promoteFeedbackToRoadmap("fb-1", "ws-1", "NEXT", "/path")
    ).rejects.toThrow("Feedback item not found");

    expect(mockFeedbackItem.findFirst).toHaveBeenCalledWith({
      where: {
        id: "fb-1",
        workspaceId: "ws-1",
        workspace: { members: { some: { userId: "user-1" } } },
      },
      select: { title: true },
    });
    expect(mockRoadmapItem.create).not.toHaveBeenCalled();
  });

  it("rejects feedback from another workspace without writing", async () => {
    mockFeedbackItem.findFirst.mockResolvedValue(null);

    await expect(
      promoteFeedbackToRoadmap("fb-other", "ws-1", "NEXT", "/path")
    ).rejects.toThrow("Feedback item not found");

    expect(mockFeedbackItem.findFirst).toHaveBeenCalledWith({
      where: {
        id: "fb-other",
        workspaceId: "ws-1",
        workspace: { members: { some: { userId: "user-1" } } },
      },
      select: { title: true },
    });
    expect(mockRoadmapItem.create).not.toHaveBeenCalled();
  });

  it("creates a roadmap item for an authorized same-workspace member", async () => {
    const result = await promoteFeedbackToRoadmap("fb-1", "ws-1", "NEXT", "/path");
    const data = mockRoadmapItem.create.mock.calls[0][0].data;
    expect(data.title).toBe("Login button is broken");
    expect(data.feedbackId).toBe("fb-1");
    expect(data.workspaceId).toBe("ws-1");
    expect(data.horizon).toBe("NEXT");
    expect(result).toMatchObject({ id: "item-1" });
  });

  it("uses the authorized workspace for roadmap creation", async () => {
    await promoteFeedbackToRoadmap("fb-1", "ws-authorized", "NEXT", "/path");

    expect(mockFeedbackItem.findFirst).toHaveBeenCalledWith({
      where: {
        id: "fb-1",
        workspaceId: "ws-authorized",
        workspace: { members: { some: { userId: "user-1" } } },
      },
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
      promoteFeedbackToRoadmap("fb-999", "ws-1", "NEXT", "/path")
    ).rejects.toThrow("Feedback item not found");
    expect(mockRoadmapItem.create).not.toHaveBeenCalled();
  });

  it("places item at sortOrder 0 when horizon is empty", async () => {
    mockRoadmapItem.findFirst.mockResolvedValue(null);
    await promoteFeedbackToRoadmap("fb-1", "ws-1", "NEXT", "/path");
    const data = mockRoadmapItem.create.mock.calls[0][0].data;
    expect(data.sortOrder).toBe(0);
  });

  it("places item after last item in horizon", async () => {
    mockRoadmapItem.findFirst.mockResolvedValue({ sortOrder: 3 });
    await promoteFeedbackToRoadmap("fb-1", "ws-1", "LATER", "/path");
    const data = mockRoadmapItem.create.mock.calls[0][0].data;
    expect(data.sortOrder).toBe(4);
  });

  it("calls revalidatePath with the passed-in path", async () => {
    const { revalidatePath } = await import("next/cache");
    await promoteFeedbackToRoadmap("fb-1", "ws-1", "NEXT", "/custom/roadmap/path");
    expect(revalidatePath).toHaveBeenCalledWith("/custom/roadmap/path");
  });

  it("propagates DB errors", async () => {
    mockRoadmapItem.create.mockRejectedValue(new Error("DB error"));
    await expect(
      promoteFeedbackToRoadmap("fb-1", "ws-1", "NEXT", "/path")
    ).rejects.toThrow("DB error");
  });

  it("passes through optional dates when scheduled directly onto the timeline", async () => {
    const startDate = new Date("2026-08-01");
    const endDate = new Date("2026-08-15");
    await promoteFeedbackToRoadmap("fb-1", "ws-1", "NEXT", "/path", { startDate, endDate });
    const data = mockRoadmapItem.create.mock.calls[0][0].data;
    expect(data.startDate).toBe(startDate);
    expect(data.endDate).toBe(endDate);
  });

  it("creates without dates when not scheduled with a timeframe", async () => {
    await promoteFeedbackToRoadmap("fb-1", "ws-1", "NEXT", "/path");
    const data = mockRoadmapItem.create.mock.calls[0][0].data;
    expect(data.startDate).toBeUndefined();
    expect(data.endDate).toBeUndefined();
  });

  it("defaults isPrivate to false when not provided", async () => {
    await promoteFeedbackToRoadmap("fb-1", "ws-1", "NEXT", "/path");
    const data = mockRoadmapItem.create.mock.calls[0][0].data;
    expect(data.isPrivate).toBe(false);
  });

  it("passes through isPrivate: true (e.g. a security-flagged bug)", async () => {
    await promoteFeedbackToRoadmap("fb-1", "ws-1", "NEXT", "/path", undefined, true);
    const data = mockRoadmapItem.create.mock.calls[0][0].data;
    expect(data.isPrivate).toBe(true);
  });
});

// ─── updateSortOrder ──────────────────────────────────────────────────────────

describe("updateSortOrder", () => {
  it("updates the sort order directly", async () => {
    await updateSortOrder("item-1", 9, "/path");
    expect(mockRoadmapItem.update).toHaveBeenCalledWith({
      where: { id: "item-1" },
      data: { sortOrder: 9 },
    });
  });
});

// ─── updateRoadmapItem ────────────────────────────────────────────────────────

describe("updateRoadmapItem", () => {
  it("updates only the provided fields and always sets updatedAt explicitly", async () => {
    const startDate = new Date("2026-08-01");
    const endDate = new Date("2026-08-15");
    await updateRoadmapItem(
      "item-1",
      { title: "Renamed", startDate, endDate },
      "/path"
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
      { description: "New description", startDate: null, endDate: null },
      "/path"
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
      updateRoadmapItem("item-missing", { title: "X" }, "/path")
    ).rejects.toThrow("Record to update not found");
  });

  it("leaves isPrivate untouched when not provided", async () => {
    await updateRoadmapItem("item-1", { title: "Renamed" }, "/path");
    const call = mockRoadmapItem.update.mock.calls[0][0];
    expect(call.data.isPrivate).toBeUndefined();
  });

  it("sets isPrivate when explicitly provided", async () => {
    await updateRoadmapItem("item-1", { isPrivate: true }, "/path");
    const call = mockRoadmapItem.update.mock.calls[0][0];
    expect(call.data.isPrivate).toBe(true);
  });

  it("can toggle isPrivate back to false", async () => {
    await updateRoadmapItem("item-1", { isPrivate: false }, "/path");
    const call = mockRoadmapItem.update.mock.calls[0][0];
    expect(call.data.isPrivate).toBe(false);
  });
});
