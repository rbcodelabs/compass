import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRoadmapItem = {
  create: vi.fn(),
  update: vi.fn(),
  findFirst: vi.fn(),
};
const mockSolution = {
  findUnique: vi.fn(),
};

const mockPrisma = {
  roadmapItem: mockRoadmapItem,
  solution: mockSolution,
};

vi.mock("@/lib/db", () => ({
  default: vi.fn(() => mockPrisma),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import {
  addRoadmapItem,
  moveItem,
  archiveItem,
  promoteToRoadmap,
  updateSortOrder,
} from "@/app/[orgSlug]/[workspaceSlug]/roadmap/actions";

beforeEach(() => {
  vi.clearAllMocks();
  mockRoadmapItem.create.mockResolvedValue({ id: "item-1", title: "Test Item" });
  mockRoadmapItem.update.mockResolvedValue({ id: "item-1" });
  mockRoadmapItem.findFirst.mockResolvedValue(null);
  mockSolution.findUnique.mockResolvedValue({ title: "My Solution" });
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
