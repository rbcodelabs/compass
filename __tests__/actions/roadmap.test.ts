import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRoadmapItem = {
  create: vi.fn(),
  update: vi.fn(),
  findFirst: vi.fn(),
};
const mockOpportunity = {
  findFirst: vi.fn(),
};
const mockSolution = {
  findUnique: vi.fn(),
};
const mockFeedbackItem = {
  findUnique: vi.fn(),
};

const mockPrisma = {
  roadmapItem: mockRoadmapItem,
  opportunity: mockOpportunity,
  solution: mockSolution,
  feedbackItem: mockFeedbackItem,
};

vi.mock("@/auth", () => ({ auth: vi.fn() }));

vi.mock("@/lib/db", () => ({
  default: vi.fn(() => mockPrisma),
}));

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
import { auth } from "@/auth";

const mockAuth = vi.mocked(auth);

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue(
    { user: { id: "user-1" } } as ReturnType<typeof auth> extends Promise<infer T> ? T : never,
  );
  mockRoadmapItem.create.mockResolvedValue({ id: "item-1", title: "Test Item" });
  mockRoadmapItem.update.mockResolvedValue({ id: "item-1" });
  mockRoadmapItem.findFirst.mockResolvedValue(null);
  mockOpportunity.findFirst.mockResolvedValue(null);
  mockSolution.findUnique.mockResolvedValue({ title: "My Solution" });
  mockFeedbackItem.findUnique.mockResolvedValue({ title: "Login button is broken" });
});

// ─── addRoadmapItem ───────────────────────────────────────────────────────────

describe("addRoadmapItem", () => {
  it("creates an item at sortOrder 0 when column is empty", async () => {
    mockRoadmapItem.findFirst.mockResolvedValue(null);
    const result = await addRoadmapItem(
      "ws-1",
      { title: "Ship payments", horizon: "NOW" },
      "/path"
    );
    const data = mockRoadmapItem.create.mock.calls[0][0].data;
    expect(data.sortOrder).toBe(0);
    expect(data.horizon).toBe("NOW");
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
      { title: "Feature Z", horizon: "NOW", keyResultId: "kr-5" },
      "/path"
    );
    const data = mockRoadmapItem.create.mock.calls[0][0].data;
    expect(data.keyResultId).toBe("kr-5");
  });

  it("propagates DB errors", async () => {
    mockRoadmapItem.create.mockRejectedValue(new Error("DB error"));
    await expect(
      addRoadmapItem("ws-1", { title: "Fail", horizon: "NOW" }, "/path")
    ).rejects.toThrow("DB error");
  });

  it("passes through optional startDate and endDate", async () => {
    const startDate = new Date("2026-07-01");
    const endDate = new Date("2026-09-30");
    await addRoadmapItem(
      "ws-1",
      { title: "Timed feature", horizon: "NOW", startDate, endDate },
      "/path"
    );
    const data = mockRoadmapItem.create.mock.calls[0][0].data;
    expect(data.startDate).toBe(startDate);
    expect(data.endDate).toBe(endDate);
  });

  it("defaults isPrivate to false when not provided", async () => {
    await addRoadmapItem("ws-1", { title: "Public by default", horizon: "NOW" }, "/path");
    const data = mockRoadmapItem.create.mock.calls[0][0].data;
    expect(data.isPrivate).toBe(false);
  });

  it("passes through isPrivate: true", async () => {
    await addRoadmapItem(
      "ws-1",
      { title: "Security fix", horizon: "NOW", isPrivate: true },
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
    expect(mockRoadmapItem.update).toHaveBeenCalledWith({
      where: { id: "item-1" },
      data: { status: "ARCHIVED" },
    });
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
    const result = await promoteToRoadmap("sol-1", "ws-1", "NOW", null, null);
    const data = mockRoadmapItem.create.mock.calls[0][0].data;
    expect(data.title).toBe("Great Solution");
    expect(data.solutionId).toBe("sol-1");
    expect(result).toMatchObject({ id: "item-1" });
  });

  it("throws when solution is not found", async () => {
    mockSolution.findUnique.mockResolvedValue(null);
    await expect(
      promoteToRoadmap("sol-999", "ws-1", "NOW", null, null)
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
    await promoteToRoadmap("sol-1", "ws-1", "NOW", "squad-1", "opp-1");
    const data = mockRoadmapItem.create.mock.calls[0][0].data;
    expect(data.squadId).toBe("squad-1");
    expect(data.opportunityId).toBe("opp-1");
  });

  it("passes through optional dates when scheduled directly onto the timeline", async () => {
    const startDate = new Date("2026-07-01");
    const endDate = new Date("2026-09-30");
    await promoteToRoadmap("sol-1", "ws-1", "NOW", null, null, { startDate, endDate });
    const data = mockRoadmapItem.create.mock.calls[0][0].data;
    expect(data.startDate).toBe(startDate);
    expect(data.endDate).toBe(endDate);
  });

  it("creates without dates when not scheduled with a timeframe", async () => {
    await promoteToRoadmap("sol-1", "ws-1", "NOW", null, null);
    const data = mockRoadmapItem.create.mock.calls[0][0].data;
    expect(data.startDate).toBeUndefined();
    expect(data.endDate).toBeUndefined();
  });

  it("defaults isPrivate to false when not provided", async () => {
    await promoteToRoadmap("sol-1", "ws-1", "NOW", null, null);
    const data = mockRoadmapItem.create.mock.calls[0][0].data;
    expect(data.isPrivate).toBe(false);
  });

  it("passes through isPrivate: true", async () => {
    await promoteToRoadmap("sol-1", "ws-1", "NOW", null, null, undefined, true);
    const data = mockRoadmapItem.create.mock.calls[0][0].data;
    expect(data.isPrivate).toBe(true);
  });
});

// ─── promoteFeedbackToRoadmap ─────────────────────────────────────────────────

describe("promoteFeedbackToRoadmap", () => {
  it("creates a roadmap item using the feedback title", async () => {
    mockFeedbackItem.findUnique.mockResolvedValue({ title: "Login button is broken" });
    const result = await promoteFeedbackToRoadmap("fb-1", "ws-1", "NOW", "/path");
    const data = mockRoadmapItem.create.mock.calls[0][0].data;
    expect(data.title).toBe("Login button is broken");
    expect(data.feedbackId).toBe("fb-1");
    expect(data.workspaceId).toBe("ws-1");
    expect(data.horizon).toBe("NOW");
    expect(result).toMatchObject({ id: "item-1" });
  });

  it("throws when feedback item is not found", async () => {
    mockFeedbackItem.findUnique.mockResolvedValue(null);
    await expect(
      promoteFeedbackToRoadmap("fb-999", "ws-1", "NOW", "/path")
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
    await promoteFeedbackToRoadmap("fb-1", "ws-1", "NOW", "/custom/roadmap/path");
    expect(revalidatePath).toHaveBeenCalledWith("/custom/roadmap/path");
  });

  it("propagates DB errors", async () => {
    mockRoadmapItem.create.mockRejectedValue(new Error("DB error"));
    await expect(
      promoteFeedbackToRoadmap("fb-1", "ws-1", "NOW", "/path")
    ).rejects.toThrow("DB error");
  });

  it("passes through optional dates when scheduled directly onto the timeline", async () => {
    const startDate = new Date("2026-08-01");
    const endDate = new Date("2026-08-15");
    await promoteFeedbackToRoadmap("fb-1", "ws-1", "NOW", "/path", { startDate, endDate });
    const data = mockRoadmapItem.create.mock.calls[0][0].data;
    expect(data.startDate).toBe(startDate);
    expect(data.endDate).toBe(endDate);
  });

  it("creates without dates when not scheduled with a timeframe", async () => {
    await promoteFeedbackToRoadmap("fb-1", "ws-1", "NOW", "/path");
    const data = mockRoadmapItem.create.mock.calls[0][0].data;
    expect(data.startDate).toBeUndefined();
    expect(data.endDate).toBeUndefined();
  });

  it("defaults isPrivate to false when not provided", async () => {
    await promoteFeedbackToRoadmap("fb-1", "ws-1", "NOW", "/path");
    const data = mockRoadmapItem.create.mock.calls[0][0].data;
    expect(data.isPrivate).toBe(false);
  });

  it("passes through isPrivate: true (e.g. a security-flagged bug)", async () => {
    await promoteFeedbackToRoadmap("fb-1", "ws-1", "NOW", "/path", undefined, true);
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

  it("rejects an unauthenticated caller before querying roadmap data", async () => {
    mockAuth.mockResolvedValue(null as never);

    await expect(
      editRoadmapItem("item-1", editData, "/path")
    ).rejects.toThrow("Unauthorized");

    expect(mockRoadmapItem.findFirst).not.toHaveBeenCalled();
    expect(mockRoadmapItem.update).not.toHaveBeenCalled();
  });

  it("does not reveal whether an item exists to a caller outside its workspace", async () => {
    mockRoadmapItem.findFirst.mockResolvedValue(null);

    await expect(
      editRoadmapItem("item-secret", editData, "/path")
    ).rejects.toThrow("Roadmap item not found or access denied");

    expect(mockRoadmapItem.findFirst).toHaveBeenCalledWith({
      where: {
        id: "item-secret",
        workspace: { members: { some: { userId: "user-1" } } },
      },
      select: {
        id: true,
        workspaceId: true,
        opportunityId: true,
        opportunity: { select: { id: true, title: true } },
      },
    });
    expect(mockRoadmapItem.update).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", "opp-missing"],
    ["foreign-workspace", "opp-foreign"],
  ])("rejects a %s opportunity without committing scalar edits", async (_scenario, opportunityId) => {
    mockRoadmapItem.findFirst.mockResolvedValue({
      id: "item-1",
      workspaceId: "ws-1",
      opportunityId: "opp-1",
      opportunity: { id: "opp-1", title: "Existing" },
    });
    mockOpportunity.findFirst.mockResolvedValue(null);

    await expect(
      editRoadmapItem("item-1", { ...editData, opportunityId }, "/path")
    ).rejects.toThrow("Opportunity not found or access denied");

    expect(mockOpportunity.findFirst).toHaveBeenCalledWith({
      where: { id: opportunityId, workspaceId: "ws-1" },
      select: { id: true, title: true },
    });
    expect(mockRoadmapItem.update).not.toHaveBeenCalled();
  });

  it("links or changes an opportunity while leaving every other relation untouched", async () => {
    mockRoadmapItem.findFirst.mockResolvedValue({
      id: "item-1",
      workspaceId: "ws-1",
      opportunityId: "opp-1",
      opportunity: { id: "opp-1", title: "Existing" },
    });
    mockOpportunity.findFirst.mockResolvedValue({ id: "opp-2", title: "Retention friction" });
    mockRoadmapItem.update.mockResolvedValue({
      id: "item-1",
      title: "Renamed",
      description: "Updated description",
      startDate: null,
      endDate: null,
      isPrivate: true,
      opportunityId: "opp-2",
    });

    const result = await editRoadmapItem("item-1", editData, "/path");

    const call = mockRoadmapItem.update.mock.calls[0][0];
    expect(call.where).toEqual({ id: "item-1" });
    expect(call.data.title).toBe("Renamed");
    expect(call.data.description).toBe("Updated description");
    expect(call.data.isPrivate).toBe(true);
    expect(call.data.opportunityId).toBe("opp-2");
    expect(call.data.updatedAt).toBeInstanceOf(Date);
    expect(call.data).not.toHaveProperty("solutionId");
    expect(call.data).not.toHaveProperty("experimentId");
    expect(call.data).not.toHaveProperty("keyResultId");
    expect(call.data).not.toHaveProperty("feedbackId");
    expect(result).toMatchObject({
      title: "Renamed",
      opportunityId: "opp-2",
      opportunity: { id: "opp-2", title: "Retention friction" },
    });
  });

  it("clears an opportunity without requiring an opportunity lookup", async () => {
    mockRoadmapItem.findFirst.mockResolvedValue({
      id: "item-1",
      workspaceId: "ws-1",
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
      opportunityId: null,
    });

    const result = await editRoadmapItem(
      "item-1",
      { ...editData, opportunityId: null },
      "/path",
    );

    expect(mockOpportunity.findFirst).not.toHaveBeenCalled();
    expect(mockRoadmapItem.update.mock.calls[0][0].data).toMatchObject({
      title: "Renamed",
      opportunityId: null,
      updatedAt: expect.any(Date),
    });
    expect(result).toMatchObject({ opportunityId: null, opportunity: null });
  });

  it("preserves the current opportunity without a redundant relation lookup or write", async () => {
    const currentOpportunity = { id: "opp-archived", title: "Archived opportunity" };
    mockRoadmapItem.findFirst.mockResolvedValue({
      id: "item-1",
      workspaceId: "ws-1",
      opportunityId: currentOpportunity.id,
      opportunity: currentOpportunity,
    });
    mockRoadmapItem.update.mockResolvedValue({
      id: "item-1",
      title: "Renamed",
      description: "Updated description",
      startDate: null,
      endDate: null,
      isPrivate: true,
      opportunityId: currentOpportunity.id,
    });

    const result = await editRoadmapItem(
      "item-1",
      { ...editData, opportunityId: currentOpportunity.id },
      "/path",
    );

    expect(mockOpportunity.findFirst).not.toHaveBeenCalled();
    expect(mockRoadmapItem.update.mock.calls[0][0].data).not.toHaveProperty("opportunityId");
    expect(result.opportunity).toEqual(currentOpportunity);
  });
});
