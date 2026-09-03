import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockAuth } = vi.hoisted(() => ({ mockAuth: vi.fn() }));

const roadmapItem = {
  create: vi.fn(),
  findFirst: vi.fn(),
  update: vi.fn(),
};
const workspaceMember = { findUnique: vi.fn() };
const solution = { findFirst: vi.fn() };
const opportunity = { findFirst: vi.fn() };
const squad = { findFirst: vi.fn() };
const experiment = { findFirst: vi.fn() };
const keyResult = { findFirst: vi.fn() };
const feedbackItem = { findFirst: vi.fn() };
const portfolioCapacityReservation = { findUnique: vi.fn(), update: vi.fn() };
const portfolioCapacityPlan = { updateMany: vi.fn() };
const nowGateEvaluation = { create: vi.fn() };

const prisma = {
  roadmapItem,
  workspaceMember,
  solution,
  opportunity,
  squad,
  experiment,
  keyResult,
  feedbackItem,
  portfolioCapacityReservation,
  portfolioCapacityPlan,
  nowGateEvaluation,
  $transaction: vi.fn(),
};

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/db", () => ({ default: () => prisma }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { revalidatePath } from "next/cache";
import {
  addRoadmapItem,
  archiveItem,
  moveItem,
  promoteFeedbackToRoadmap,
  promoteToRoadmap,
  rescheduleRoadmapItem,
  updateRoadmapItem,
  updateSortOrder,
} from "@/app/[orgSlug]/[workspaceSlug]/roadmap/actions";

const WS = "workspace-a";
const OTHER_WS = "workspace-b";
const ITEM = "item-a";

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "user-a" } });
  workspaceMember.findUnique.mockResolvedValue({ id: "member-a" });
  roadmapItem.findFirst.mockImplementation(({ where }: { where: { id?: string } }) =>
    where.id ? Promise.resolve({ id: where.id, workspaceId: WS, horizon: "NEXT", status: "ACTIVE" }) : Promise.resolve(null),
  );
  roadmapItem.create.mockResolvedValue({ id: ITEM });
  roadmapItem.update.mockResolvedValue({ id: ITEM });
  solution.findFirst.mockResolvedValue({ title: "Solution", opportunityId: "opp-a" });
  opportunity.findFirst.mockResolvedValue({ id: "opp-a" });
  squad.findFirst.mockResolvedValue({ id: "squad-a" });
  experiment.findFirst.mockResolvedValue({ id: "experiment-a" });
  keyResult.findFirst.mockResolvedValue({ id: "kr-a" });
  feedbackItem.findFirst.mockResolvedValue({ title: "Feedback" });
  portfolioCapacityReservation.findUnique.mockResolvedValue(null);
  portfolioCapacityPlan.updateMany.mockResolvedValue({ count: 1 });
  prisma.$transaction.mockImplementation((callback: (tx: typeof prisma) => unknown) => callback(prisma));
});

describe("roadmap mutation authorization", () => {
  const mutationCalls = [
    ["add", () => addRoadmapItem(WS, { title: "Item", horizon: "NEXT" })],
    ["update", () => updateRoadmapItem(ITEM, WS, { title: "Item" })],
    ["move", () => moveItem(ITEM, "LATER", WS)],
    ["archive", () => archiveItem(ITEM, WS)],
    ["promote solution", () => promoteToRoadmap("solution-a", WS, "NEXT", null, null)],
    ["promote feedback", () => promoteFeedbackToRoadmap("feedback-a", WS, "NEXT")],
    ["sort", () => updateSortOrder(ITEM, WS, 2)],
    ["reschedule", () => rescheduleRoadmapItem(ITEM, WS, { horizon: "LATER", startDate: null, endDate: null })],
  ] as const;

  it.each(mutationCalls)("rejects unauthenticated %s before database access", async (_name, invoke) => {
    mockAuth.mockResolvedValue(null);
    await expect(invoke()).rejects.toThrow("Unauthorized");
    expect(workspaceMember.findUnique).not.toHaveBeenCalled();
    expect(roadmapItem.create).not.toHaveBeenCalled();
    expect(roadmapItem.update).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it.each(mutationCalls)("rejects non-member %s without writing", async (_name, invoke) => {
    workspaceMember.findUnique.mockResolvedValue(null);
    await expect(invoke()).rejects.toThrow("Workspace not found");
    expect(roadmapItem.create).not.toHaveBeenCalled();
    expect(roadmapItem.update).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("rejects an unauthenticated add before any database access", async () => {
    mockAuth.mockResolvedValue(null);

    await expect(addRoadmapItem(WS, { title: "No", horizon: "NEXT" })).rejects.toThrow("Unauthorized");

    expect(workspaceMember.findUnique).not.toHaveBeenCalled();
    expect(roadmapItem.create).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("rejects a non-member add without writing", async () => {
    workspaceMember.findUnique.mockResolvedValue(null);

    await expect(addRoadmapItem(WS, { title: "No", horizon: "NEXT" })).rejects.toThrow("Workspace not found");

    expect(roadmapItem.create).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("rejects every foreign relationship before creating an item", async () => {
    solution.findFirst.mockResolvedValue(null);

    await expect(addRoadmapItem(WS, { title: "No", horizon: "NEXT", solutionId: "foreign" })).rejects.toThrow("Related record not found");

    expect(roadmapItem.create).not.toHaveBeenCalled();
  });

  it.each([
    ["solutionId", solution],
    ["keyResultId", keyResult],
    ["opportunityId", opportunity],
    ["experimentId", experiment],
  ] as const)("rejects a foreign %s on add before creating", async (field, delegate) => {
    delegate.findFirst.mockResolvedValueOnce(null);
    await expect(addRoadmapItem(WS, { title: "No", horizon: "NEXT", [field]: "foreign" })).rejects.toThrow("Related record not found");
    expect(roadmapItem.create).not.toHaveBeenCalled();
  });

  it.each(["LAUNCHING", "LAUNCHED"] as const)("rejects direct creation in %s", async (horizon) => {
    await expect(addRoadmapItem(WS, { title: "No", horizon })).rejects.toThrow(/launch tier/i);
    expect(roadmapItem.create).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("scopes an update target to the authorized workspace", async () => {
    roadmapItem.findFirst.mockResolvedValue(null);

    await expect(updateRoadmapItem(ITEM, OTHER_WS, { title: "No" })).rejects.toThrow("Roadmap item not found");

    expect(roadmapItem.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: ITEM, workspaceId: OTHER_WS } }));
    expect(roadmapItem.update).not.toHaveBeenCalled();
  });

  it("requires membership for move, archive, and sort before writing", async () => {
    workspaceMember.findUnique.mockResolvedValue(null);

    await expect(moveItem(ITEM, "LATER", WS)).rejects.toThrow("Workspace not found");
    await expect(archiveItem(ITEM, WS)).rejects.toThrow("Workspace not found");
    await expect(updateSortOrder(ITEM, WS, 4)).rejects.toThrow("Workspace not found");

    expect(roadmapItem.update).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("rejects a foreign solution promotion before creating", async () => {
    solution.findFirst.mockResolvedValue(null);

    await expect(promoteToRoadmap("foreign", WS, "NEXT", null, null)).rejects.toThrow("Solution not found");

    expect(roadmapItem.create).not.toHaveBeenCalled();
  });

  it.each([
    ["opportunity", opportunity, null, "foreign"],
    ["squad", squad, "foreign", null],
  ] as const)("rejects a foreign promotion %s before creating", async (_name, delegate, squadId, opportunityId) => {
    delegate.findFirst.mockResolvedValueOnce(null);
    await expect(promoteToRoadmap("solution-a", WS, "NEXT", squadId, opportunityId)).rejects.toThrow("Related record not found");
    expect(roadmapItem.create).not.toHaveBeenCalled();
  });

  it("rejects foreign feedback before creating", async () => {
    feedbackItem.findFirst.mockResolvedValueOnce(null);
    await expect(promoteFeedbackToRoadmap("foreign", WS, "NEXT")).rejects.toThrow("Feedback item not found");
    expect(roadmapItem.create).not.toHaveBeenCalled();
  });

  const dateCreationCalls = [
    ["add", (dates?: { startDate?: Date; endDate?: Date }) => addRoadmapItem(WS, { title: "Item", horizon: "NEXT", ...dates })],
    ["solution promotion", (dates?: { startDate?: Date; endDate?: Date }) => promoteToRoadmap("solution-a", WS, "NEXT", null, null, dates)],
    ["feedback promotion", (dates?: { startDate?: Date; endDate?: Date }) => promoteFeedbackToRoadmap("feedback-a", WS, "NEXT", dates)],
  ] as const;

  it.each(dateCreationCalls)("rejects a partial date range for %s before writing", async (_name, invoke) => {
    await expect(invoke({ startDate: new Date("2026-09-08T00:00:00.000Z") })).rejects.toThrow(/inclusive range/);
    expect(roadmapItem.create).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it.each(dateCreationCalls)("rejects a reversed date range for %s before writing", async (_name, invoke) => {
    await expect(invoke({
      startDate: new Date("2026-09-09T00:00:00.000Z"),
      endDate: new Date("2026-09-08T00:00:00.000Z"),
    })).rejects.toThrow(/inclusive range/);
    expect(roadmapItem.create).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it.each(dateCreationCalls)("accepts a complete valid date range for %s", async (_name, invoke) => {
    await invoke({
      startDate: new Date("2026-09-08T00:00:00.000Z"),
      endDate: new Date("2026-09-09T00:00:00.000Z"),
    });
    expect(roadmapItem.create).toHaveBeenCalledTimes(1);
  });

  it.each(dateCreationCalls)("accepts both dates absent for %s", async (_name, invoke) => {
    await invoke();
    expect(roadmapItem.create).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["update", () => updateRoadmapItem(ITEM, WS, { title: "No" })],
    ["move", () => moveItem(ITEM, "LATER", WS)],
    ["archive", () => archiveItem(ITEM, WS)],
    ["sort", () => updateSortOrder(ITEM, WS, 2)],
  ] as const)("rejects a cross-workspace %s target without writing", async (_name, invoke) => {
    roadmapItem.findFirst.mockResolvedValueOnce(null);
    await expect(invoke()).rejects.toThrow("Roadmap item not found");
    expect(roadmapItem.update).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("rescheduleRoadmapItem", () => {
  it("persists horizon, inclusive dates, and destination order in one transaction", async () => {
    const startDate = new Date("2026-09-07T00:00:00.000Z");
    const endDate = new Date("2026-09-11T00:00:00.000Z");
    roadmapItem.findFirst
      .mockResolvedValueOnce({ id: ITEM, workspaceId: WS, horizon: "NEXT", status: "ACTIVE" })
      .mockResolvedValueOnce({ sortOrder: 3 });

    await rescheduleRoadmapItem(ITEM, WS, { horizon: "LATER", startDate, endDate });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(roadmapItem.update).toHaveBeenCalledWith({
      where: { id: ITEM },
      data: expect.objectContaining({ horizon: "LATER", startDate, endDate, sortOrder: 4 }),
    });
    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
  });

  it("admits direct entry to NOW transactionally while the native gate is OFF", async () => {
    await rescheduleRoadmapItem(ITEM, WS, {
      horizon: "NOW",
      startDate: new Date("2026-09-07T00:00:00.000Z"),
      endDate: new Date("2026-09-11T00:00:00.000Z"),
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(roadmapItem.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ horizon: "NOW" }),
    }));
  });

  it("allows a date-only reschedule for an item already in NOW without releasing capacity", async () => {
    roadmapItem.findFirst
      .mockResolvedValueOnce({ id: ITEM, workspaceId: WS, horizon: "NOW", status: "ACTIVE", sortOrder: 6 });

    await rescheduleRoadmapItem(ITEM, WS, {
      horizon: "NOW",
      startDate: new Date("2026-09-07T00:00:00.000Z"),
      endDate: new Date("2026-09-11T00:00:00.000Z"),
    });

    expect(portfolioCapacityReservation.findUnique).not.toHaveBeenCalled();
    expect(roadmapItem.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ sortOrder: 6 }),
    }));
  });

  it("preserves sort order for a same-horizon NEXT date update", async () => {
    roadmapItem.findFirst.mockResolvedValueOnce({ id: ITEM, workspaceId: WS, horizon: "NEXT", status: "ACTIVE", sortOrder: 4 });

    await rescheduleRoadmapItem(ITEM, WS, {
      horizon: "NEXT",
      startDate: new Date("2026-09-14T00:00:00.000Z"),
      endDate: new Date("2026-09-18T00:00:00.000Z"),
    });

    expect(roadmapItem.findFirst).toHaveBeenCalledTimes(1);
    expect(roadmapItem.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ sortOrder: 4 }),
    }));
  });

  it("rejects launch horizons without opening a transaction", async () => {
    await expect(
      rescheduleRoadmapItem(ITEM, WS, {
        horizon: "LAUNCHING",
        startDate: new Date("2026-09-07T00:00:00.000Z"),
        endDate: new Date("2026-09-11T00:00:00.000Z"),
      }),
    ).rejects.toThrow(/launch tier/i);

    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("reschedules from NOW without policy, capacity, or telemetry I/O", async () => {
    roadmapItem.findFirst
      .mockResolvedValueOnce({ id: ITEM, workspaceId: WS, horizon: "NOW", status: "ACTIVE" })
      .mockResolvedValueOnce(null);

    await rescheduleRoadmapItem(ITEM, WS, {
      horizon: "NEXT",
      startDate: new Date("2026-09-07T00:00:00.000Z"),
      endDate: new Date("2026-09-11T00:00:00.000Z"),
    });

    expect(portfolioCapacityReservation.findUnique).not.toHaveBeenCalled();
    expect(portfolioCapacityReservation.update).not.toHaveBeenCalled();
    expect(portfolioCapacityPlan.updateMany).not.toHaveBeenCalled();
    expect(prisma.nowGateEvaluation.create).not.toHaveBeenCalled();
    expect(roadmapItem.update).toHaveBeenCalled();
  });

  it("does not revalidate when the transaction rolls back", async () => {
    prisma.$transaction.mockRejectedValue(new Error("rollback"));

    await expect(
      rescheduleRoadmapItem(ITEM, WS, {
        horizon: "LATER",
        startDate: new Date("2026-09-07T00:00:00.000Z"),
        endDate: new Date("2026-09-11T00:00:00.000Z"),
      }),
    ).rejects.toThrow("rollback");

    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("rejects a cross-workspace target inside the transaction without writing", async () => {
    roadmapItem.findFirst.mockResolvedValueOnce(null);
    await expect(rescheduleRoadmapItem(ITEM, WS, { horizon: "LATER", startDate: null, endDate: null })).rejects.toThrow("Roadmap item not found");
    expect(roadmapItem.update).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("rejects a partial or reversed inclusive date range without a transaction", async () => {
    await expect(rescheduleRoadmapItem(ITEM, WS, {
      horizon: "LATER", startDate: new Date("2026-09-08T00:00:00.000Z"), endDate: null,
    })).rejects.toThrow(/inclusive range/);
    await expect(rescheduleRoadmapItem(ITEM, WS, {
      horizon: "LATER", startDate: new Date("2026-09-08T00:00:00.000Z"), endDate: new Date("2026-09-07T00:00:00.000Z"),
    })).rejects.toThrow(/inclusive range/);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("rolls back item state when the item update fails", async () => {
    const canonical = {
      item: { id: ITEM, workspaceId: WS, horizon: "NOW", status: "ACTIVE", sortOrder: 1 },
      plan: { id: "plan-a", version: 2, state: "ACTIVE" },
      reservation: { id: "reservation-a", planId: "plan-a", state: "ACTIVE", activeRoadmapItemId: ITEM as string | null, releasedAt: null as Date | null },
    };
    const before = structuredClone(canonical);
    const txRoadmapFindFirst = vi.fn()
      .mockResolvedValueOnce({ id: ITEM, workspaceId: WS, horizon: "NOW", status: "ACTIVE" })
      .mockResolvedValueOnce(null);
    const txRoadmapUpdate = vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      Object.assign(canonical.item, data);
      throw new Error("item update failed");
    });
    prisma.$transaction.mockImplementationOnce(async (callback: (tx: typeof prisma) => unknown) => {
      const snapshot = structuredClone(canonical);
      const tx = {
        ...prisma,
        roadmapItem: { ...roadmapItem, findFirst: txRoadmapFindFirst, update: txRoadmapUpdate },
      };
      try {
        return await callback(tx);
      } catch (error) {
        canonical.item = snapshot.item;
        canonical.plan = snapshot.plan;
        canonical.reservation = snapshot.reservation;
        throw error;
      }
    });

    await expect(rescheduleRoadmapItem(ITEM, WS, { horizon: "NEXT", startDate: null, endDate: null })).rejects.toThrow("item update failed");

    expect(txRoadmapUpdate).toHaveBeenCalledTimes(1);
    expect(canonical).toEqual(before);
    expect(roadmapItem.update).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
