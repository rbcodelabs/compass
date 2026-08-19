import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockAuth, mockGetWorkspace, mockRevalidatePath, prisma } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockGetWorkspace: vi.fn(),
  mockRevalidatePath: vi.fn(),
  prisma: {
    roadmapItem: { findFirst: vi.fn() },
    workspaceMember: { findFirst: vi.fn() },
    task: { findFirst: vi.fn(), create: vi.fn() },
    taskLink: { upsert: vi.fn() },
  },
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/workspace", () => ({ getWorkspace: mockGetWorkspace }));
vi.mock("@/lib/db", () => ({ default: () => prisma }));
vi.mock("next/cache", () => ({ revalidatePath: mockRevalidatePath }));

import { addRoadmapDeliveryTask, linkRoadmapDeliveryTask } from "@/app/[orgSlug]/[workspaceSlug]/tasks/roadmap-delivery-actions";

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "user-1" } });
  mockGetWorkspace.mockResolvedValue({ id: "ws-1" });
  prisma.roadmapItem.findFirst.mockResolvedValue({ id: "roadmap-1" });
  prisma.task.findFirst.mockResolvedValue(null);
  prisma.task.create.mockResolvedValue({ id: "task-new" });
  prisma.taskLink.upsert.mockResolvedValue({ id: "link-1" });
});

describe("roadmap delivery task actions", () => {
  it("creates a task and roadmap link together in the authorized workspace", async () => {
    await addRoadmapDeliveryTask("acme", "product", "roadmap-1", { title: " Ship it " });
    expect(prisma.roadmapItem.findFirst).toHaveBeenCalledWith({ where: { id: "roadmap-1", workspaceId: "ws-1" }, select: { id: true } });
    expect(prisma.task.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: "ws-1",
        title: "Ship it",
        status: "TODO",
        links: { create: { linkedType: "ROADMAP_ITEM", linkedId: "roadmap-1" } },
      }),
    });
    expect(mockRevalidatePath).toHaveBeenCalledWith("/acme/product/roadmap");
  });

  it("rejects an existing task from another workspace before linking", async () => {
    prisma.task.findFirst.mockResolvedValue(null);
    await expect(linkRoadmapDeliveryTask("acme", "product", "roadmap-1", "foreign-task")).rejects.toThrow("Not found");
    expect(prisma.task.findFirst).toHaveBeenCalledWith({
      where: { id: "foreign-task", workspaceId: "ws-1", status: { not: "CANCELLED" } },
      select: { id: true },
    });
    expect(prisma.taskLink.upsert).not.toHaveBeenCalled();
  });

  it("derives the roadmap invalidation path when linking an existing task", async () => {
    prisma.task.findFirst.mockResolvedValue({ id: "task-1" });
    await linkRoadmapDeliveryTask("acme", "product", "roadmap-1", "task-1");
    expect(mockRevalidatePath).toHaveBeenCalledWith("/acme/product/roadmap");
  });

  it("does not query roadmap or tasks when the caller lacks workspace membership", async () => {
    mockGetWorkspace.mockResolvedValue(null);
    await expect(linkRoadmapDeliveryTask("acme", "product", "roadmap-1", "task-1")).rejects.toThrow("Not found");
    expect(prisma.roadmapItem.findFirst).not.toHaveBeenCalled();
    expect(prisma.task.findFirst).not.toHaveBeenCalled();
  });
});
