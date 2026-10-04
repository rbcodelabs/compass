import { describe, expect, it, vi } from "vitest";
import { createFakePrisma, solutionRow, type FakeState } from "./roadmap-fake-prisma";

vi.mock("@/lib/workspace-update-mutations", () => ({
  captureWorkspaceMutation: async (_prisma: unknown, _model: string, _op: string, _source: unknown, _id: unknown, mutate: (tx: unknown) => Promise<unknown>) => mutate(_prisma),
}));

import { autoRoadmapItemId, createRoadmapItemsFromSolutions, deterministicUuid } from "@/lib/roadmap/create-from-solution";

const context = { workspaceId: "ws-1", source: "UI", captureSource: "UI" as const, userId: "user-1", today: "2026-10-05" };
const fresh = (): FakeState => ({
  solutions: [solutionRow("s1"), solutionRow("s2"), solutionRow("s3", { opportunity: { id: "opp-s3", squadId: null, linkedKeyResultId: null } })],
  squads: [{ id: "squad-a", workspaceId: "ws-1" }, { id: "squad-b", workspaceId: "ws-1" }],
  items: [],
});

describe("createRoadmapItemsFromSolutions", () => {
  it("links the item to the solution and inherits title, squad, opportunity and key result", async () => {
    const state = fresh();
    const result = await createRoadmapItemsFromSolutions(createFakePrisma(state), context, [{ solutionId: "s1" }]);
    expect(result.created).toHaveLength(1);
    expect(state.items[0]).toMatchObject({
      solutionId: "s1",
      title: "Solution s1",
      squadId: "squad-a",
      opportunityId: "opp-s1",
      keyResultId: "kr-1",
      source: "UI",
      createdById: "user-1",
      status: "ACTIVE",
    });
  });

  it("defaults to a six-week slot starting today, and derives the horizon from the start", async () => {
    const state = fresh();
    await createRoadmapItemsFromSolutions(createFakePrisma(state), context, [{ solutionId: "s1" }]);
    const [item] = state.items;
    expect((item.startDate as Date).toISOString().slice(0, 10)).toBe("2026-10-05");
    expect((item.endDate as Date).toISOString().slice(0, 10)).toBe("2026-11-15");
    expect(item.horizon).toBe("NOW");
  });

  it("is idempotent: a solution that already has an ACTIVE item is reported, not duplicated", async () => {
    const state = fresh();
    const prisma = createFakePrisma(state);
    await createRoadmapItemsFromSolutions(prisma, context, [{ solutionId: "s1" }]);
    const second = await createRoadmapItemsFromSolutions(prisma, context, [{ solutionId: "s1" }, { solutionId: "s2" }]);
    expect(second.existing).toEqual([{ solutionId: "s1", itemId: state.items[0].id }]);
    expect(second.created.map((item) => item.solutionId)).toEqual(["s2"]);
    expect(state.items.filter((item) => item.solutionId === "s1")).toHaveLength(1);
  });

  it("collapses a solution listed twice in one request", async () => {
    const state = fresh();
    await createRoadmapItemsFromSolutions(createFakePrisma(state), context, [{ solutionId: "s1" }, { solutionId: "s1" }]);
    expect(state.items).toHaveLength(1);
  });

  it("places a batch on non-overlapping slots within a squad but side by side across squads", async () => {
    const state = fresh();
    state.solutions.push(solutionRow("s4", { opportunity: { id: "opp-s4", squadId: "squad-b", linkedKeyResultId: null } }));
    await createRoadmapItemsFromSolutions(createFakePrisma(state), context, [{ solutionId: "s1" }, { solutionId: "s2" }, { solutionId: "s4" }]);
    const byId = Object.fromEntries(state.items.map((item) => [item.solutionId as string, item]));
    const day = (value: unknown) => (value as Date).toISOString().slice(0, 10);
    expect(day(byId.s1.startDate)).toBe("2026-10-05");
    expect(day(byId.s2.startDate)).toBe("2026-11-16"); // squad-a: after s1
    expect(day(byId.s4.startDate)).toBe("2026-10-05"); // squad-b: its own row
  });

  it("honours explicit squad and dates, and squad null means no squad", async () => {
    const state = fresh();
    await createRoadmapItemsFromSolutions(createFakePrisma(state), context, [
      { solutionId: "s1", squadId: "squad-b", startDate: "2027-01-04", endDate: "2027-01-31", horizon: "NEXT" },
      { solutionId: "s2", squadId: null },
    ]);
    const [first, second] = state.items;
    expect(first).toMatchObject({ squadId: "squad-b", horizon: "NEXT" });
    expect((first.startDate as Date).toISOString().slice(0, 10)).toBe("2027-01-04");
    expect(second.squadId).toBeNull();
  });

  it("leaves shipped work undated unless dates are given", async () => {
    const state = fresh();
    await createRoadmapItemsFromSolutions(createFakePrisma(state), context, [{ solutionId: "s1", horizon: "SHIPPED" }]);
    expect(state.items[0]).toMatchObject({ horizon: "SHIPPED", startDate: undefined, endDate: undefined });
  });

  it("rejects an inverted range, a foreign squad, and reports solutions outside the workspace", async () => {
    const state = fresh();
    const prisma = createFakePrisma(state);
    await expect(createRoadmapItemsFromSolutions(prisma, context, [{ solutionId: "s1", startDate: "2026-12-10", endDate: "2026-12-01" }])).rejects.toThrow(/inclusive range/);
    await expect(createRoadmapItemsFromSolutions(prisma, context, [{ solutionId: "s1", squadId: "other-workspace-squad" }])).rejects.toThrow("Related record not found");
    const result = await createRoadmapItemsFromSolutions(prisma, context, [{ solutionId: "nope" }]);
    expect(result.missing).toEqual(["nope"]);
    expect(state.items).toHaveLength(0);
  });

  it("flags auto-created items and uses a fixed id so a second insert conflicts instead of duplicating", async () => {
    const state = fresh();
    const prisma = createFakePrisma(state);
    const auto = { ...context, autoCreated: true };
    const first = await createRoadmapItemsFromSolutions(prisma, auto, [{ solutionId: "s1", horizon: "NOW", id: autoRoadmapItemId("s1") }]);
    expect(first.created[0].id).toBe(autoRoadmapItemId("s1"));
    expect(state.items[0].autoCreated).toBe(true);
    // The user removes it; a later attempt must not resurrect or duplicate it.
    state.items[0].status = "ARCHIVED";
    const again = await createRoadmapItemsFromSolutions(prisma, auto, [{ solutionId: "s1", horizon: "NOW", id: autoRoadmapItemId("s1") }]);
    expect(again.created).toHaveLength(0);
    expect(again.conflicts).toEqual(["s1"]);
    expect(state.items).toHaveLength(1);
  });
});

describe("deterministicUuid", () => {
  it("is stable, namespaced and well-formed", () => {
    expect(autoRoadmapItemId("abc")).toBe(autoRoadmapItemId("abc"));
    expect(autoRoadmapItemId("abc")).not.toBe(autoRoadmapItemId("abd"));
    expect(deterministicUuid("a", "x")).not.toBe(deterministicUuid("b", "x"));
    expect(autoRoadmapItemId("abc")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
