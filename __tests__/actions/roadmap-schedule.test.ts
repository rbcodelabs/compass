import { beforeEach, describe, expect, it, vi } from "vitest";
import { solutionRow, type FakeState } from "../lib/roadmap-fake-prisma";

const { mockAuth, revalidate, state, membership } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  revalidate: vi.fn(),
  state: { solutions: [], squads: [], items: [] } as { solutions: Record<string, unknown>[]; squads: Record<string, unknown>[]; items: Record<string, unknown>[] },
  membership: { current: null as null | { id: string } },
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("next/cache", () => ({ revalidatePath: revalidate }));
vi.mock("@/lib/workspace-update-mutations", () => ({
  captureWorkspaceMutation: async (_p: unknown, _m: string, _o: string, _s: unknown, _id: unknown, mutate: (tx: unknown) => Promise<unknown>) => mutate(_p),
  workspaceMutationActor: async () => ({ actorType: "USER", actorId: "user-1" }),
}));
vi.mock("@/lib/workspace-updates-capture", () => ({
  workspaceUpdatesAvailable: async () => false,
  recordWorkspaceUpdate: vi.fn(),
  retryUpdatesTransaction: vi.fn(),
}));
vi.mock("@/lib/db", async () => {
  const { createFakePrisma: build } = await import("../lib/roadmap-fake-prisma");
  const fake = build(state as FakeState) as unknown as Record<string, unknown>;
  const withMembership = { ...fake, workspaceMember: { findUnique: async () => membership.current }, roadmapItem: { ...(fake.roadmapItem as object), count: async () => 0 } };
  return { default: () => withMembership };
});

import {
  buildRoadmapFromDiscovery,
  scheduleSolutionsToRoadmap,
  undoRoadmapCreate,
} from "@/app/[orgSlug]/[workspaceSlug]/roadmap/actions";

const WS = "ws-1";
const day = (value: unknown) => (value as Date).toISOString().slice(0, 10);

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "user-1" } });
  membership.current = { id: "member-1" };
  state.solutions = [
    solutionRow("s1", { status: "VALIDATED", score: { normalizedScore: 90 } }),
    solutionRow("s2", { status: "VALIDATED", score: { normalizedScore: 60 } }),
    solutionRow("s3", { status: "IN_DELIVERY", score: { normalizedScore: 75 }, opportunity: { id: "opp-s3", squadId: "squad-b", linkedKeyResultId: null } }),
    solutionRow("s4", { status: "IDEA", score: { normalizedScore: 99 } }),
  ];
  state.squads = [{ id: "squad-a", workspaceId: WS }, { id: "squad-b", workspaceId: WS }];
  state.items = [];
});

describe("scheduleSolutionsToRoadmap", () => {
  it("rejects an unauthenticated caller and a non-member before reading or writing anything", async () => {
    mockAuth.mockResolvedValue(null);
    await expect(scheduleSolutionsToRoadmap(WS, [{ solutionId: "s1" }])).rejects.toThrow("Unauthorized");
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    membership.current = null;
    await expect(scheduleSolutionsToRoadmap(WS, [{ solutionId: "s1" }])).rejects.toThrow("Workspace not found");
    expect(state.items).toHaveLength(0);
    expect(revalidate).not.toHaveBeenCalled();
  });

  it("creates a linked item shaped like the page renders it, records the creator and revalidates", async () => {
    const result = await scheduleSolutionsToRoadmap(WS, [{ solutionId: "s1" }], "2026-10-05");
    expect(result.created).toHaveLength(1);
    expect(result.created[0]).toMatchObject({ solutionId: "s1", title: "Solution s1", horizon: "NOW", startDate: "2026-10-05T00:00:00.000Z", endDate: "2026-11-15T00:00:00.000Z", autoCreated: false });
    expect(state.items[0]).toMatchObject({ createdById: "user-1", source: "UI", squadId: "squad-a", keyResultId: "kr-1" });
    expect(revalidate).toHaveBeenCalled();
  });

  it("is idempotent per solution: scheduling twice never duplicates", async () => {
    await scheduleSolutionsToRoadmap(WS, [{ solutionId: "s1" }], "2026-10-05");
    const again = await scheduleSolutionsToRoadmap(WS, [{ solutionId: "s1" }, { solutionId: "s2" }], "2026-10-05");
    expect(again.created.map((card) => card.solutionId)).toEqual(["s2"]);
    expect(again.existing).toEqual([{ solutionId: "s1", itemId: state.items[0].id }]);
    expect(state.items.filter((item) => item.solutionId === "s1")).toHaveLength(1);
  });

  it("uses the row's squad and the dropped dates, and validates input", async () => {
    await scheduleSolutionsToRoadmap(WS, [{ solutionId: "s1", horizon: "NEXT", squadId: "squad-b", startDate: "2026-12-01", endDate: "2026-12-14" }], "2026-10-05");
    expect(state.items[0]).toMatchObject({ horizon: "NEXT", squadId: "squad-b" });
    expect(day(state.items[0].startDate)).toBe("2026-12-01");
    await expect(scheduleSolutionsToRoadmap(WS, [{ solutionId: "s2", startDate: "12/01/2026", endDate: "2026-12-14" }])).rejects.toThrow("Start date must be a YYYY-MM-DD date");
    await expect(scheduleSolutionsToRoadmap(WS, [{ solutionId: "s2", endDate: "2026-12-14" }])).rejects.toThrow("An end date needs a start date");
    await expect(scheduleSolutionsToRoadmap(WS, [{ solutionId: "s2", horizon: "LAUNCHING" as never }])).rejects.toThrow("Invalid horizon");
    await expect(scheduleSolutionsToRoadmap(WS, Array.from({ length: 101 }, (_, index) => ({ solutionId: `s${index}` })))).rejects.toThrow("at most 100");
  });

  it("does not schedule a solution from another workspace", async () => {
    state.solutions.push(solutionRow("foreign", { workspaceId: "other-ws" }));
    const result = await scheduleSolutionsToRoadmap(WS, [{ solutionId: "foreign" }]);
    expect(result.missing).toEqual(["foreign"]);
    expect(state.items).toHaveLength(0);
  });
});

describe("buildRoadmapFromDiscovery", () => {
  it("batch-creates the 'validated' preset at non-overlapping slots, best score first per squad", async () => {
    const result = await buildRoadmapFromDiscovery(WS, "validated", "2026-10-05");
    expect(result.created.map((card) => card.solutionId)).toEqual(["s1", "s2"]);
    const [first, second] = state.items;
    expect(day(first.startDate)).toBe("2026-10-05");
    expect(day(first.endDate)).toBe("2026-11-15");
    expect(day(second.startDate)).toBe("2026-11-16"); // same squad: after the first, no overlap
    expect(first).toMatchObject({ createdById: "user-1", source: "UI" });
    expect(revalidate).toHaveBeenCalled();
  });

  it("'building' takes only in-delivery solutions and 'top-scored' only ready ones scoring 70+", async () => {
    await buildRoadmapFromDiscovery(WS, "building", "2026-10-05");
    expect(state.items.map((item) => item.solutionId)).toEqual(["s3"]);
    state.items = [];
    await buildRoadmapFromDiscovery(WS, "top-scored", "2026-10-05");
    expect(state.items.map((item) => item.solutionId).sort()).toEqual(["s1", "s3"]);
  });

  it("skips solutions that are already on the roadmap and respects what a squad already has booked", async () => {
    state.items.push({ id: "busy", workspaceId: WS, status: "ACTIVE", solutionId: "s2", squadId: "squad-a", startDate: new Date("2026-10-05T00:00:00Z"), endDate: new Date("2026-10-31T00:00:00Z"), sortOrder: 0 });
    const result = await buildRoadmapFromDiscovery(WS, "validated", "2026-10-05");
    expect(result.created.map((card) => card.solutionId)).toEqual(["s1"]);
    expect(day(state.items.find((item) => item.solutionId === "s1")!.startDate)).toBe("2026-11-01");
  });

  it("rejects a non-member", async () => {
    membership.current = null;
    await expect(buildRoadmapFromDiscovery(WS, "validated")).rejects.toThrow("Workspace not found");
  });
});

describe("undoRoadmapCreate", () => {
  it("archives the items and never touches the solutions", async () => {
    await scheduleSolutionsToRoadmap(WS, [{ solutionId: "s1" }, { solutionId: "s2" }], "2026-10-05");
    const solutionsBefore = JSON.stringify(state.solutions);
    const ids = state.items.map((item) => item.id as string);
    const result = await undoRoadmapCreate(WS, ids);
    expect(result.archived.sort()).toEqual([...ids].sort());
    expect(state.items.every((item) => item.status === "ARCHIVED")).toBe(true);
    expect(JSON.stringify(state.solutions)).toBe(solutionsBefore);
    // Archived items leave the roadmap, so the same solutions can be scheduled again.
    const again = await scheduleSolutionsToRoadmap(WS, [{ solutionId: "s1" }], "2026-10-05");
    expect(again.created).toHaveLength(1);
  });

  it("only archives ACTIVE items in this workspace and rejects a non-member", async () => {
    state.items.push({ id: "foreign", workspaceId: "other-ws", status: "ACTIVE", solutionId: null }, { id: "done", workspaceId: WS, status: "ARCHIVED", solutionId: null });
    const result = await undoRoadmapCreate(WS, ["foreign", "done"]);
    expect(result.archived).toEqual([]);
    expect(state.items.find((item) => item.id === "foreign")!.status).toBe("ACTIVE");
    membership.current = null;
    await expect(undoRoadmapCreate(WS, ["foreign"])).rejects.toThrow("Workspace not found");
  });

  it("keeps an archived auto-created item as the marker that stops auto-sync re-adding it", async () => {
    state.items.push({ id: "auto", workspaceId: WS, status: "ACTIVE", solutionId: "s3", autoCreated: true, sortOrder: 0 });
    await undoRoadmapCreate(WS, ["auto"]);
    expect(state.items.find((item) => item.id === "auto")).toMatchObject({ status: "ARCHIVED", autoCreated: true });
  });
});

