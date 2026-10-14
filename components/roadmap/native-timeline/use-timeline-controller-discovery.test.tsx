// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const viewUrl = vi.hoisted(() => ({ query: "" }));
vi.mock("@/hooks/use-url-state", () => ({ useUrlState: () => ({ params: new URLSearchParams(viewUrl.query), set: vi.fn() }) }));

const actions = vi.hoisted(() => ({
  promoteFeedbackToRoadmap: vi.fn(),
  rescheduleRoadmapItem: vi.fn(),
  scheduleSolutionsToRoadmap: vi.fn(),
  buildRoadmapFromDiscovery: vi.fn(),
  undoRoadmapCreate: vi.fn(),
}));
const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/app/[orgSlug]/[workspaceSlug]/roadmap/actions", () => actions);
vi.mock("@/components/panels/panel-context", () => ({
  usePanelContext: () => ({ subscribeEntityMutated: () => () => undefined }),
}));

import { useTimelineController } from "./use-timeline-controller";
import { getUndoToasts, resetUndoToasts } from "@/lib/ui/undo-toast";
import type { ScheduleCatalog } from "@/lib/roadmap/rail";

const rail = (id: string, over: Record<string, unknown> = {}) => ({
  kind: "solution" as const,
  id,
  title: `Solution ${id}`,
  opportunityId: "opp-1",
  opportunityTitle: "Opportunity one",
  squadId: "squad-a",
  status: "VALIDATED",
  score: 70,
  ...over,
});
const card = (id: string, solutionId: string, over: Record<string, unknown> = {}) => ({
  id,
  title: `Solution ${solutionId}`,
  description: null,
  horizon: "NOW",
  sortOrder: 0,
  isPrivate: false,
  solutionId,
  keyResultId: null,
  opportunityId: "opp-1",
  experimentId: null,
  feedbackId: null,
  startDate: "2026-10-05T00:00:00.000Z",
  endDate: "2026-11-15T00:00:00.000Z",
  updatedAt: "2026-10-04T12:00:00.000Z",
  autoCreated: false,
  solution: { id: solutionId, title: `Solution ${solutionId}` },
  keyResult: null,
  opportunity: { id: "opp-1", title: "Opportunity one" },
  experiment: null,
  feedback: null,
  squad: { id: "squad-a", name: "Alpha", color: "#222222" },
  launchChecklist: null,
  deliveryStatus: "NOT_STARTED",
  ...over,
});
const catalog = (over: Partial<ScheduleCatalog> = {}): ScheduleCatalog => ({
  solutions: [
    { id: "s1", title: "Solution s1", status: "VALIDATED", score: 70, opportunityId: "opp-1", opportunityTitle: "Opportunity one", squadId: "squad-a" },
    { id: "s2", title: "Solution s2", status: "IN_DELIVERY", score: 90, opportunityId: "opp-1", opportunityTitle: "Opportunity one", squadId: "squad-a" },
    { id: "s3", title: "Solution s3", status: "IDEA", score: null, opportunityId: "opp-1", opportunityTitle: "Opportunity one", squadId: null },
  ],
  opportunities: [{ id: "opp-1", title: "Opportunity one", squadId: "squad-a" }],
  scheduledSolutionIds: [],
  ...over,
});
const created = (...cards: ReturnType<typeof card>[]) => ({ created: cards, existing: [], missing: [] });

function setup(over: { catalog?: ScheduleCatalog; unscheduled?: ReturnType<typeof rail>[]; items?: ReturnType<typeof card>[] } = {}) {
  // Stable references, like the server props a real page passes between refreshes.
  const props = {
    initialItems: (over.items ?? []) as never[],
    initialUnscheduled: (over.unscheduled ?? [rail("s1"), rail("s2", { status: "IN_DELIVERY", score: 90 })]) as never[],
    workspaceId: "workspace-1",
    initialCatalog: over.catalog ?? catalog(),
  };
  return renderHook(() => useTimelineController(props));
}

beforeEach(() => {
  viewUrl.query = "";
  Object.values(actions).forEach((fn) => fn.mockReset());
  router.refresh.mockReset();
  resetUndoToasts();
});
afterEach(() => { cleanup(); resetUndoToasts(); });

describe("useTimelineController: scheduling solutions from discovery", () => {
  it("adds the new bar, takes the solution off the rail, marks it scheduled and offers Undo", async () => {
    actions.scheduleSolutionsToRoadmap.mockResolvedValue(created(card("item-1", "s1")));
    const { result } = setup();

    let returned: unknown[] = [];
    await act(async () => { returned = await result.current.scheduleSolutions([{ solutionId: "s1" }]); });

    expect(actions.scheduleSolutionsToRoadmap).toHaveBeenCalledWith("workspace-1", [{ solutionId: "s1" }], expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/));
    expect(returned).toHaveLength(1);
    expect(result.current.items.map((item) => item.id)).toEqual(["item-1"]);
    expect(result.current.unscheduled.map((item) => item.id)).toEqual(["s2"]);
    expect(result.current.scheduledSolutionIds.has("s1")).toBe(true);
    expect(router.refresh).toHaveBeenCalled();
    expect(getUndoToasts()).toHaveLength(1);
    expect(getUndoToasts()[0]).toMatchObject({ message: "Created roadmap item “Solution s1”", actionLabel: "Undo" });
  });

  it("reports solutions that were already scheduled without creating anything or toasting", async () => {
    actions.scheduleSolutionsToRoadmap.mockResolvedValue({ created: [], existing: [{ solutionId: "s1", itemId: "item-9" }], missing: [] });
    const { result } = setup();
    await act(async () => { await result.current.scheduleSolutions([{ solutionId: "s1" }]); });
    expect(result.current.items).toHaveLength(0);
    expect(result.current.unscheduled.map((item) => item.id)).toEqual(["s2"]);
    expect(getUndoToasts()).toHaveLength(0);
    expect(result.current.announcement).toBe("Already on the roadmap");
  });

  it("ignores a second request for a solution that is still being created", async () => {
    let settle: (value: unknown) => void = () => undefined;
    actions.scheduleSolutionsToRoadmap.mockImplementation(() => new Promise((resolve) => { settle = resolve; }));
    const { result } = setup();
    let first: Promise<unknown> = Promise.resolve();
    act(() => { first = result.current.scheduleSolutions([{ solutionId: "s1" }]); });
    expect(result.current.pendingBacklogIds.has("unscheduled:solution:s1")).toBe(true);
    await act(async () => { expect(await result.current.scheduleSolutions([{ solutionId: "s1" }])).toEqual([]); });
    expect(actions.scheduleSolutionsToRoadmap).toHaveBeenCalledTimes(1);
    await act(async () => { settle(created(card("item-1", "s1"))); await first; });
    expect(result.current.pendingBacklogIds.size).toBe(0);
  });

  it("leaves the rail untouched and rethrows when the server rejects", async () => {
    actions.scheduleSolutionsToRoadmap.mockRejectedValue(new Error("nope"));
    const { result } = setup();
    await act(async () => { await expect(result.current.scheduleSolutions([{ solutionId: "s1" }])).rejects.toThrow("nope"); });
    expect(result.current.unscheduled.map((item) => item.id)).toEqual(["s1", "s2"]);
    expect(result.current.items).toHaveLength(0);
    expect(result.current.pendingBacklogIds.size).toBe(0);
    expect(getUndoToasts()).toHaveLength(0);
  });

  it("does not draw a created bar the active squad filter hides, but still schedules it", async () => {
    viewUrl.query = "squad=squad-z";
    actions.scheduleSolutionsToRoadmap.mockResolvedValue(created(card("item-1", "s1")));
    const { result } = setup();
    await act(async () => { await result.current.scheduleSolutions([{ solutionId: "s1" }]); });
    expect(result.current.items).toHaveLength(0);
    expect(result.current.unscheduled.map((item) => item.id)).toEqual(["s2"]);
  });

  it("uses a caller-supplied message and can skip the toast", async () => {
    actions.scheduleSolutionsToRoadmap.mockResolvedValue(created(card("a", "s1"), card("b", "s2")));
    const { result } = setup();
    await act(async () => { await result.current.scheduleSolutions([{ solutionId: "s1" }, { solutionId: "s2" }], { message: "Auto-fit 2 items by score and squad capacity" }); });
    expect(getUndoToasts()[0].message).toBe("Auto-fit 2 items by score and squad capacity");
    resetUndoToasts();
    actions.scheduleSolutionsToRoadmap.mockResolvedValue(created(card("c", "s3")));
    await act(async () => { await result.current.scheduleSolutions([{ solutionId: "s3" }], { silent: true }); });
    expect(getUndoToasts()).toHaveLength(0);
  });
});

describe("useTimelineController: Undo", () => {
  it("archives the created items and puts the exact rail card back; the solution is never touched", async () => {
    actions.scheduleSolutionsToRoadmap.mockResolvedValue(created(card("item-1", "s1")));
    actions.undoRoadmapCreate.mockResolvedValue({ archived: ["item-1"] });
    const { result } = setup();
    await act(async () => { await result.current.scheduleSolutions([{ solutionId: "s1" }]); });

    await act(async () => { await getUndoToasts()[0].onAction?.(); });

    expect(actions.undoRoadmapCreate).toHaveBeenCalledWith("workspace-1", ["item-1"]);
    expect(result.current.items).toHaveLength(0);
    expect(result.current.unscheduled.map((item) => item.id).sort()).toEqual(["s1", "s2"]);
    expect(result.current.scheduledSolutionIds.has("s1")).toBe(false);
    expect(result.current.announcement).toBe("Removed from the roadmap");
  });

  it("restores an auto-added item's solution to the rail from the catalog", async () => {
    // s2 is In delivery and was auto-added server-side before this page loaded: it is not in the rail.
    const auto = card("auto-1", "s2", { autoCreated: true });
    actions.undoRoadmapCreate.mockResolvedValue({ archived: ["auto-1"] });
    const { result } = setup({ items: [auto], unscheduled: [rail("s1")], catalog: catalog({ scheduledSolutionIds: ["s2"] }) });
    expect(result.current.scheduledSolutionIds.has("s2")).toBe(true);

    await act(async () => { await result.current.undoCreated(["auto-1"]); });

    expect(actions.undoRoadmapCreate).toHaveBeenCalledWith("workspace-1", ["auto-1"]);
    expect(result.current.items).toHaveLength(0);
    expect(result.current.unscheduled.map((item) => item.id)).toEqual(["s1", "s2"]);
    expect(result.current.unscheduled.find((item) => item.id === "s2")).toMatchObject({ status: "IN_DELIVERY", score: 90 });
  });

  it("does not put a solution that is not ready (an idea) back in the rail", async () => {
    actions.undoRoadmapCreate.mockResolvedValue({ archived: ["item-3"] });
    const { result } = setup({ items: [card("item-3", "s3")], unscheduled: [], catalog: catalog({ scheduledSolutionIds: ["s3"] }) });
    await act(async () => { await result.current.undoCreated(["item-3"]); });
    expect(result.current.unscheduled).toHaveLength(0);
    expect(result.current.scheduledSolutionIds.has("s3")).toBe(false);
  });

  it("keeps everything as it was when the undo fails", async () => {
    actions.scheduleSolutionsToRoadmap.mockResolvedValue(created(card("item-1", "s1")));
    actions.undoRoadmapCreate.mockRejectedValue(new Error("server down"));
    const { result } = setup();
    await act(async () => { await result.current.scheduleSolutions([{ solutionId: "s1" }]); });
    await act(async () => { await expect(result.current.undoCreated(["item-1"])).rejects.toThrow("server down"); });
    expect(result.current.items.map((item) => item.id)).toEqual(["item-1"]);
  });
});

describe("useTimelineController: build from discovery", () => {
  it("creates the batch for a preset with today's local date and offers one Undo for all of it", async () => {
    actions.buildRoadmapFromDiscovery.mockResolvedValue(created(card("a", "s1"), card("b", "s2")));
    const { result } = setup();
    await act(async () => { await result.current.buildFromDiscovery("validated"); });
    expect(actions.buildRoadmapFromDiscovery).toHaveBeenCalledWith("workspace-1", "validated", expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/));
    expect(result.current.items.map((item) => item.id)).toEqual(["a", "b"]);
    expect(result.current.unscheduled).toHaveLength(0);
    expect(getUndoToasts()).toHaveLength(1);
    expect(getUndoToasts()[0].message).toBe("Created 2 roadmap items from discovery. Review and drag to adjust.");

    actions.undoRoadmapCreate.mockResolvedValue({ archived: ["a", "b"] });
    await act(async () => { await getUndoToasts()[0].onAction?.(); });
    expect(actions.undoRoadmapCreate).toHaveBeenCalledWith("workspace-1", ["a", "b"]);
    expect(result.current.items).toHaveLength(0);
    expect(result.current.unscheduled.map((item) => item.id).sort()).toEqual(["s1", "s2"]);
  });
});
