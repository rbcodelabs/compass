import { describe, expect, it, vi } from "vitest";
import { createFakePrisma, solutionRow, type FakeState } from "./roadmap-fake-prisma";

vi.mock("@/lib/workspace-update-mutations", () => ({
  captureWorkspaceMutation: async (_prisma: unknown, _model: string, _op: string, _source: unknown, _id: unknown, mutate: (tx: unknown) => Promise<unknown>) => mutate(_prisma),
}));

import { syncRoadmapOnSolutionChange } from "@/lib/roadmap/solution-sync";
import { autoRoadmapItemId } from "@/lib/roadmap/create-from-solution";

const context = { source: "UI", captureSource: "UI" as const, userId: "user-1", today: "2026-10-05" };
const fresh = (): FakeState => ({
  solutions: [solutionRow("s1")],
  squads: [{ id: "squad-a", workspaceId: "ws-1" }],
  items: [],
});
const building = { solutionId: "s1", workspaceId: "ws-1", previousStatus: "VALIDATED", status: "IN_DELIVERY" };
const day = (value: unknown) => (value as Date).toISOString().slice(0, 10);

describe("syncRoadmapOnSolutionChange: auto-add at Building", () => {
  it("creates one flagged, linked item at the first free slot when a solution reaches Building", async () => {
    const state = fresh();
    const result = await syncRoadmapOnSolutionChange(createFakePrisma(state), context, building);
    expect(result.autoAdded).toMatchObject({ itemId: autoRoadmapItemId("s1"), start: "2026-10-05" });
    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({
      solutionId: "s1",
      autoCreated: true,
      horizon: "NOW",
      squadId: "squad-a",
      keyResultId: "kr-1",
      createdById: "user-1",
      source: "UI",
    });
  });

  it("slots the new item after what the squad already has scheduled", async () => {
    const state = fresh();
    state.items.push({ id: "busy", workspaceId: "ws-1", status: "ACTIVE", solutionId: null, squadId: "squad-a", startDate: new Date("2026-10-01T00:00:00Z"), endDate: new Date("2026-10-31T00:00:00Z"), sortOrder: 0 });
    await syncRoadmapOnSolutionChange(createFakePrisma(state), context, building);
    expect(day(state.items[1].startDate)).toBe("2026-11-01");
  });

  it("does nothing for Validated: it stays in the rail as ready to schedule", async () => {
    const state = fresh();
    const result = await syncRoadmapOnSolutionChange(createFakePrisma(state), context, { ...building, previousStatus: "IDEA", status: "VALIDATED" });
    expect(result.autoAdded).toBeNull();
    expect(result.skipped).toBe("not-building");
    expect(state.items).toHaveLength(0);
  });

  it("is idempotent when the same transition arrives twice", async () => {
    const state = fresh();
    const prisma = createFakePrisma(state);
    await syncRoadmapOnSolutionChange(prisma, context, building);
    const second = await syncRoadmapOnSolutionChange(prisma, context, building);
    expect(second.autoAdded).toBeNull();
    expect(state.items).toHaveLength(1);
  });

  it("does not add a second item when a person already scheduled the solution", async () => {
    const state = fresh();
    state.items.push({ id: "manual", workspaceId: "ws-1", status: "ACTIVE", solutionId: "s1", title: "Solution s1", horizon: "NEXT", squadId: "squad-a", startDate: new Date("2026-12-01T00:00:00Z"), endDate: new Date("2026-12-14T00:00:00Z"), sortOrder: 0 });
    const result = await syncRoadmapOnSolutionChange(createFakePrisma(state), context, building);
    expect(result.autoAdded).toBeNull();
    expect(result.skipped).toBe("already-scheduled");
    expect(state.items).toHaveLength(1);
  });

  it("never re-adds an auto-created item the user removed, even after leaving and re-entering Building", async () => {
    const state = fresh();
    const prisma = createFakePrisma(state);
    await syncRoadmapOnSolutionChange(prisma, context, building);
    state.items[0].status = "ARCHIVED"; // Undo / remove
    const solutionsBefore = JSON.stringify(state.solutions);
    const again = await syncRoadmapOnSolutionChange(prisma, context, building);
    expect(again.autoAdded).toBeNull();
    expect(again.skipped).toBe("suppressed");
    expect(state.items).toHaveLength(1);
    expect(state.items[0].status).toBe("ARCHIVED");
    // Removing a roadmap item never modifies the source solution.
    expect(JSON.stringify(state.solutions)).toBe(solutionsBefore);
  });

  it("reports a sync failure instead of throwing: the status change already committed", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const broken = { roadmapItem: { findMany: async () => { throw new Error("db down"); } } } as never;
    const result = await syncRoadmapOnSolutionChange(broken, context, building);
    expect(result.error).toBe("db down");
    expect(result.autoAdded).toBeNull();
    spy.mockRestore();
  });
});

describe("syncRoadmapOnSolutionChange: linked items follow the solution", () => {
  const linked = (overrides: Record<string, unknown> = {}) => ({
    id: "manual", workspaceId: "ws-1", status: "ACTIVE", solutionId: "s1", title: "Solution s1", horizon: "NEXT", squadId: "squad-a",
    startDate: new Date("2026-12-01T00:00:00Z"), endDate: new Date("2026-12-14T00:00:00Z"), sortOrder: 0, scheduleEditedAt: null, ...overrides,
  });

  it("pulls an unedited item to Now and today when its solution starts building", async () => {
    const state = fresh();
    state.items.push(linked());
    await syncRoadmapOnSolutionChange(createFakePrisma(state), context, building);
    expect(state.items[0]).toMatchObject({ horizon: "NOW" });
    expect(day(state.items[0].startDate)).toBe("2026-10-05");
    expect(day(state.items[0].endDate)).toBe("2026-10-18");
  });

  it("stops following dates once the user edited the schedule", async () => {
    const state = fresh();
    state.items.push(linked({ scheduleEditedAt: new Date("2026-09-30T00:00:00Z") }));
    await syncRoadmapOnSolutionChange(createFakePrisma(state), context, building);
    expect(state.items[0].horizon).toBe("NEXT");
    expect(day(state.items[0].startDate)).toBe("2026-12-01");
  });

  it("follows a rename only while the item still carries the old title", async () => {
    const state = fresh();
    state.items.push(linked(), linked({ id: "renamed", title: "Custom roadmap name" }));
    await syncRoadmapOnSolutionChange(createFakePrisma(state), context, { solutionId: "s1", workspaceId: "ws-1", previousTitle: "Solution s1", title: "Better name" });
    expect(state.items.find((item) => item.id === "manual")?.title).toBe("Better name");
    expect(state.items.find((item) => item.id === "renamed")?.title).toBe("Custom roadmap name");
  });
});
