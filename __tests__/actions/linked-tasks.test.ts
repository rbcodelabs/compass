import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockAuth, mockGetWorkspace, mockRevalidatePath, prisma } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockGetWorkspace: vi.fn(),
  mockRevalidatePath: vi.fn(),
  prisma: {
    roadmapItem: { findFirst: vi.fn() },
    opportunity: { findFirst: vi.fn() },
    workspaceMember: { findFirst: vi.fn() },
    task: { findFirst: vi.fn(), create: vi.fn() },
    taskLink: { upsert: vi.fn() },
    $transaction: vi.fn(),
  },
}));

// The entity_links mirror of task links (ADR phase 7) has its own tests (__tests__/links/task-reference-mirror.test.ts); this file pins the legacy writes against hand-written fakes.
vi.mock("@/lib/links/legacy-mirror", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/links/legacy-mirror")>()), mirrorTaskReference: vi.fn(), unmirrorTaskReference: vi.fn() }));
vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/workspace", () => ({ getWorkspace: mockGetWorkspace }));
vi.mock("@/lib/db", () => ({ default: () => prisma }));
vi.mock("next/cache", () => ({ revalidatePath: mockRevalidatePath }));

import { addLinkedTask, linkExistingTask } from "@/app/[orgSlug]/[workspaceSlug]/tasks/actions";

vi.mock("@/lib/work-item-sequence", async () => (await import("../helpers/work-item-sequence-mock")).workItemSequenceMock())

beforeEach(() => {
  vi.clearAllMocks();
  // Numbered creates run in a transaction; the fake is its own transaction client.
  prisma.$transaction.mockImplementation(async (callback: (tx: typeof prisma) => unknown) => callback(prisma));
  mockAuth.mockResolvedValue({ user: { id: "user-1" } });
  mockGetWorkspace.mockResolvedValue({ id: "ws-1" });
  prisma.roadmapItem.findFirst.mockResolvedValue({ id: "roadmap-1" });
  prisma.opportunity.findFirst.mockResolvedValue({ id: "opp-1" });
  prisma.task.findFirst.mockResolvedValue(null);
  prisma.task.create.mockResolvedValue({ id: "task-new" });
  prisma.taskLink.upsert.mockResolvedValue({ id: "link-1" });
});

describe("addLinkedTask", () => {
  it("creates a task and links it to a roadmap item in the authorized workspace", async () => {
    await addLinkedTask("acme", "product", "ROADMAP_ITEM", "roadmap-1", { title: " Ship it " }, "/acme/product/roadmap");
    expect(prisma.roadmapItem.findFirst).toHaveBeenCalledWith({ where: { id: "roadmap-1", workspaceId: "ws-1" } });
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

  it("creates a task linked to any other TaskLink-eligible entity, e.g. an opportunity", async () => {
    await addLinkedTask("acme", "product", "OPPORTUNITY", "opp-1", { title: "Investigate" }, "/acme/product/discovery/opp-1");
    expect(prisma.opportunity.findFirst).toHaveBeenCalledWith({ where: { id: "opp-1", workspaceId: "ws-1" } });
    expect(prisma.task.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ links: { create: { linkedType: "OPPORTUNITY", linkedId: "opp-1" } } }),
    });
    expect(mockRevalidatePath).toHaveBeenCalledWith("/acme/product/discovery/opp-1");
  });

  it("rejects when the linked object belongs to a different workspace or doesn't exist", async () => {
    prisma.opportunity.findFirst.mockResolvedValue(null);
    await expect(
      addLinkedTask("acme", "product", "OPPORTUNITY", "foreign-opp", { title: "X" }, "/path")
    ).rejects.toThrow("different workspace");
    expect(prisma.task.create).not.toHaveBeenCalled();
  });

  it("rejects an empty title", async () => {
    await expect(
      addLinkedTask("acme", "product", "ROADMAP_ITEM", "roadmap-1", { title: "   " }, "/path")
    ).rejects.toThrow("Title is required");
    expect(prisma.task.create).not.toHaveBeenCalled();
  });

  it("does not query the linked target when the caller lacks workspace membership", async () => {
    mockGetWorkspace.mockResolvedValue(null);
    await expect(
      addLinkedTask("acme", "product", "ROADMAP_ITEM", "roadmap-1", { title: "X" }, "/path")
    ).rejects.toThrow("Not found");
    expect(prisma.roadmapItem.findFirst).not.toHaveBeenCalled();
    expect(prisma.task.create).not.toHaveBeenCalled();
  });
});

describe("linkExistingTask", () => {
  it("rejects an existing task from another workspace before linking", async () => {
    prisma.task.findFirst.mockResolvedValue(null);
    await expect(
      linkExistingTask("acme", "product", "ROADMAP_ITEM", "roadmap-1", "foreign-task", "/path")
    ).rejects.toThrow("Not found");
    expect(prisma.task.findFirst).toHaveBeenCalledWith({
      where: { id: "foreign-task", workspaceId: "ws-1", status: { not: "CANCELLED" } },
      select: { id: true },
    });
    expect(prisma.taskLink.upsert).not.toHaveBeenCalled();
  });

  it("upserts the link when linking an existing task", async () => {
    prisma.task.findFirst.mockResolvedValue({ id: "task-1" });
    await linkExistingTask("acme", "product", "ROADMAP_ITEM", "roadmap-1", "task-1", "/acme/product/roadmap");
    expect(prisma.taskLink.upsert).toHaveBeenCalledWith({
      where: { taskId_linkedType_linkedId: { taskId: "task-1", linkedType: "ROADMAP_ITEM", linkedId: "roadmap-1" } },
      create: { taskId: "task-1", linkedType: "ROADMAP_ITEM", linkedId: "roadmap-1" },
      update: {},
    });
    expect(mockRevalidatePath).toHaveBeenCalledWith("/acme/product/roadmap");
  });

  it("does not query the linked target or tasks when the caller lacks workspace membership", async () => {
    mockGetWorkspace.mockResolvedValue(null);
    await expect(
      linkExistingTask("acme", "product", "ROADMAP_ITEM", "roadmap-1", "task-1", "/path")
    ).rejects.toThrow("Not found");
    expect(prisma.roadmapItem.findFirst).not.toHaveBeenCalled();
    expect(prisma.task.findFirst).not.toHaveBeenCalled();
  });
});
