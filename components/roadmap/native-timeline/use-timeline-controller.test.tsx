// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const actions = vi.hoisted(() => ({
  promoteFeedbackToRoadmap: vi.fn(),
  promoteToRoadmap: vi.fn(),
  rescheduleRoadmapItem: vi.fn(),
}));
const panel = vi.hoisted(() => ({ listener: null as null | ((id: string, patch?: { horizon?: string; updatedAt?: string }) => void) }));
const router = vi.hoisted(() => ({ refresh: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => router,
}));

vi.mock("@/app/[orgSlug]/[workspaceSlug]/roadmap/actions", () => actions);
vi.mock("@/components/panels/panel-context", () => ({
  usePanelContext: () => ({
    subscribeEntityMutated: (_type: string, listener: typeof panel.listener) => {
      panel.listener = listener;
      return () => { panel.listener = null; };
    },
  }),
}));

import { localCalendarToday, useTimelineController } from "./use-timeline-controller";

const ack = (horizon = "LATER", startDate = "2026-10-01", endDate = "2026-10-14", updatedAt = "2026-09-05T12:00:00.000Z") => ({
  id: "item-1", horizon, startDate: new Date(`${startDate}T00:00:00.000Z`), endDate: new Date(`${endDate}T00:00:00.000Z`), updatedAt: new Date(updatedAt),
});

beforeEach(() => {
  actions.promoteFeedbackToRoadmap.mockReset();
  actions.promoteToRoadmap.mockReset();
  actions.rescheduleRoadmapItem.mockReset();
  panel.listener = null;
  router.refresh.mockReset();
});

describe("useTimelineController scheduling failures", () => {
  it("reconciles authoritative item props after a server refresh", () => {
    const initialItem = {
      id: "item-1", title: "Server-owned", horizon: "NEXT", squad: null,
      startDate: "2026-09-01", endDate: "2026-09-14",
      updatedAt: "2026-09-05T10:00:00.000Z",
    };
    const { result, rerender } = renderHook(
      ({ initialItems }) => useTimelineController({
        initialItems: initialItems as never[],
        initialUnscheduled: [],
        workspaceId: "workspace-1",
      }),
      { initialProps: { initialItems: [initialItem] } },
    );

    rerender({
      initialItems: [{
        id: "item-1", title: "Server-owned", squad: null,
        horizon: "LATER",
        startDate: "2026-10-01",
        endDate: "2026-10-14",
        updatedAt: "2026-09-05T11:00:00.000Z",
      }],
    });

    expect(result.current.items[0]).toMatchObject({
      horizon: "LATER",
      viewStart: "2026-10-01",
      viewEnd: "2026-10-14",
    });
  });

  it("reconciles additions while preserving mounted evidence across omissions", () => {
    const first = { id: "item-1", title: "First", horizon: "NEXT", squad: null, startDate: "2026-09-01", endDate: "2026-09-14" };
    const second = { id: "item-2", title: "Second", horizon: "LATER", squad: null, startDate: "2026-10-01", endDate: "2026-10-14" };
    const { result, rerender } = renderHook(
      ({ initialItems }) => useTimelineController({ initialItems: initialItems as never[], initialUnscheduled: [], workspaceId: "workspace-1" }),
      { initialProps: { initialItems: [first] } },
    );
    rerender({ initialItems: [first, second] });
    expect(result.current.items.map((item) => item.id)).toEqual(["item-1", "item-2"]);
    rerender({ initialItems: [second] });
    expect(result.current.items.map((item) => item.id)).toEqual(["item-2", "item-1"]);
  });

  it("does not carry omitted mounted evidence into a fresh remount", () => {
    const item = { id: "item-1", title: "Mounted", horizon: "NEXT", squad: null, startDate: null, endDate: null, updatedAt: "2026-09-05T10:00:00.000Z" };
    const mounted = renderHook(() => useTimelineController({ initialItems: [item] as never[], initialUnscheduled: [], workspaceId: "workspace-1" }));
    mounted.unmount();
    const fresh = renderHook(() => useTimelineController({ initialItems: [], initialUnscheduled: [], workspaceId: "workspace-1" }));
    expect(fresh.result.current.items).toEqual([]);
  });

  it("reconciles authoritative backlog props after a promoted item refresh", () => {
    const backlogItem = { kind: "feedback" as const, id: "feedback-1", title: "Promote me" };
    const { result, rerender } = renderHook(
      ({ initialUnscheduled }) => useTimelineController({
        initialItems: [],
        initialUnscheduled,
        workspaceId: "workspace-1",
      }),
      { initialProps: { initialUnscheduled: [backlogItem] } },
    );

    rerender({ initialUnscheduled: [] });

    expect(result.current.unscheduled).toEqual([]);
  });

  it("fences a divergent refresh during a command and rolls back to confirmed authority", async () => {
    let reject!: (error: Error) => void;
    actions.rescheduleRoadmapItem.mockImplementation(() => new Promise((_resolve, rejectPromise) => { reject = rejectPromise; }));
    const original = { id: "item-1", title: "Move", horizon: "NEXT", squad: null, startDate: "2026-09-01", endDate: "2026-09-14", updatedAt: "2026-09-05T10:00:00.000Z" };
    const { result, rerender } = renderHook(
      ({ initialItems }) => useTimelineController({ initialItems: initialItems as never[], initialUnscheduled: [], workspaceId: "workspace-1" }),
      { initialProps: { initialItems: [original] } },
    );

    let save!: Promise<void>;
    act(() => { save = result.current.reschedule("item-1", "LATER", "2026-11-01", "2026-11-14"); });
    rerender({ initialItems: [{ ...original, horizon: "NOW", startDate: "2026-10-01", endDate: "2026-10-14", updatedAt: "2026-09-05T11:00:00.000Z" }] });
    expect(result.current.items[0]).toMatchObject({ horizon: "LATER", viewStart: "2026-11-01" });

    act(() => reject(new Error("failed")));
    await act(async () => { await expect(save).rejects.toThrow("failed"); });
    expect(result.current.items[0]).toMatchObject({ horizon: "NEXT", viewStart: "2026-09-01", viewEnd: "2026-09-14" });
    expect(result.current.reconciliationRequiredIds).toContain("item-1");
    expect(result.current.announcement).toContain("Reload this page before another edit");
  });

  it("applies panel roadmap mutations when no local save is active", () => {
    const initialItems = [{ id: "item-1", title: "Panel", horizon: "NEXT", squad: null, startDate: "2026-09-01", endDate: "2026-09-14", updatedAt: "2026-09-05T10:00:00.000Z" } as never];
    const { result } = renderHook(() => useTimelineController({
      initialItems,
      initialUnscheduled: [], workspaceId: "workspace-1",
    }));
    act(() => panel.listener?.("item-1", { horizon: "LATER", updatedAt: "2026-09-05T11:00:00.000Z" }));
    expect(result.current.items[0].horizon).toBe("LATER");
  });

  it("does not treat a concurrent panel mutation as rollback authority", async () => {
    let reject!: (error: Error) => void;
    actions.rescheduleRoadmapItem.mockImplementation(() => new Promise((_resolve, rejectPromise) => { reject = rejectPromise; }));
    const initialItems = [{
      id: "item-1", title: "Panel during save", horizon: "NEXT", squad: null,
      startDate: "2026-09-01", endDate: "2026-09-14", updatedAt: "2026-09-05T10:00:00.000Z",
    } as never];
    const { result } = renderHook(() => useTimelineController({
      initialItems,
      initialUnscheduled: [], workspaceId: "workspace-1",
    }));

    let save!: Promise<void>;
    act(() => { save = result.current.reschedule("item-1", "LATER", "2026-11-01", "2026-11-14"); });
    act(() => panel.listener?.("item-1", { horizon: "SHIPPED", updatedAt: "2026-09-05T11:00:00.000Z" }));
    expect(result.current.items[0].horizon).toBe("LATER");

    act(() => reject(new Error("failed")));
    await act(async () => { await expect(save).rejects.toThrow("failed"); });
    expect(result.current.items[0].horizon).toBe("NEXT");
    expect(result.current.reconciliationRequiredIds).toContain("item-1");
  });

  it("keeps a later successful local save ahead of a queued panel mutation", async () => {
    let resolve!: () => void;
    actions.rescheduleRoadmapItem.mockImplementation(() => new Promise((settle) => { resolve = () => settle(ack("LATER", "2026-11-01", "2026-11-14")); }));
    const initialItems = [{ id: "item-1", title: "Concurrent", horizon: "NEXT", squad: null, startDate: "2026-09-01", endDate: "2026-09-14", updatedAt: "2026-09-05T10:00:00.000Z" } as never];
    const { result } = renderHook(() => useTimelineController({ initialItems, initialUnscheduled: [], workspaceId: "workspace-1" }));
    let save!: Promise<void>;
    act(() => { save = result.current.reschedule("item-1", "LATER", "2026-11-01", "2026-11-14"); });
    act(() => panel.listener?.("item-1", { horizon: "SHIPPED", updatedAt: "2026-09-05T10:30:00.000Z" }));
    await act(async () => { resolve(); await save; });
    expect(result.current.items[0]).toMatchObject({ horizon: "LATER", viewStart: "2026-11-01", viewEnd: "2026-11-14" });
  });

  it("uses the local calendar date across UTC midnight and DST boundaries", () => {
    const original = process.env.TZ;
    process.env.TZ = "America/Detroit";
    expect(localCalendarToday(new Date("2026-09-05T02:30:00.000Z"))).toBe("2026-09-04");
    expect(localCalendarToday(new Date("2026-03-08T06:30:00.000Z"))).toBe("2026-03-08");
    process.env.TZ = original;
  });

  it("uses the authorized atomic reschedule action for dates and horizon", async () => {
    actions.rescheduleRoadmapItem.mockResolvedValue(ack());
    const { result } = renderHook(() => useTimelineController({
      initialItems: [{
        id: "item-1", title: "Move me", horizon: "NEXT", squad: null,
        startDate: "2026-09-01", endDate: "2026-09-14",
      } as never],
      initialUnscheduled: [],
      workspaceId: "workspace-1",
    }));

    await act(() => result.current.reschedule("item-1", "LATER", "2026-10-01", "2026-10-14"));

    expect(actions.rescheduleRoadmapItem).toHaveBeenCalledWith("item-1", "workspace-1", {
      horizon: "LATER",
      startDate: new Date("2026-10-01T00:00:00.000Z"),
      endDate: new Date("2026-10-14T00:00:00.000Z"),
    });
    expect(result.current.announcement).toBe("Move me saved to Later: 2026-10-01 through 2026-10-14");
  });

  it("rolls a second failed save back to the first confirmed save before refresh", async () => {
    actions.rescheduleRoadmapItem.mockResolvedValueOnce(ack()).mockRejectedValueOnce(new Error("second failed"));
    const initialItems = [{ id: "item-1", title: "Sequential", horizon: "NEXT", squad: null, startDate: "2026-09-01", endDate: "2026-09-14" } as never];
    const { result } = renderHook(() => useTimelineController({ initialItems, initialUnscheduled: [], workspaceId: "workspace-1" }));

    await act(() => result.current.reschedule("item-1", "LATER", "2026-10-01", "2026-10-14"));
    await act(async () => {
      await expect(result.current.reschedule("item-1", "SHIPPED", "2026-11-01", "2026-11-14")).rejects.toThrow("second failed");
    });
    expect(result.current.items[0]).toMatchObject({ horizon: "LATER", viewStart: "2026-10-01", viewEnd: "2026-10-14" });
  });

  it("does not let a late pre-save prop snapshot poison the next rollback", async () => {
    actions.rescheduleRoadmapItem.mockResolvedValueOnce(ack()).mockRejectedValueOnce(new Error("second failed"));
    const original = { id: "item-1", title: "Late refresh", horizon: "NEXT", squad: null, startDate: "2026-09-01", endDate: "2026-09-14", updatedAt: "2026-09-05T10:00:00.000Z" };
    const { result, rerender } = renderHook(
      ({ initialItems }) => useTimelineController({ initialItems: initialItems as never[], initialUnscheduled: [], workspaceId: "workspace-1" }),
      { initialProps: { initialItems: [original] } },
    );

    await act(() => result.current.reschedule("item-1", "LATER", "2026-10-01", "2026-10-14"));
    rerender({ initialItems: [{ ...original }] });
    expect(result.current.items[0]).toMatchObject({ horizon: "LATER", viewStart: "2026-10-01", viewEnd: "2026-10-14" });

    await act(async () => {
      await expect(result.current.reschedule("item-1", "SHIPPED", "2026-11-01", "2026-11-14")).rejects.toThrow("second failed");
    });
    expect(result.current.items[0]).toMatchObject({ horizon: "LATER", viewStart: "2026-10-01", viewEnd: "2026-10-14" });
  });

  it("does not order a divergent post-save snapshot by timestamp", async () => {
    actions.rescheduleRoadmapItem.mockResolvedValue(ack());
    const original = { id: "item-1", title: "Revert", horizon: "NEXT", squad: null, startDate: "2026-09-01", endDate: "2026-09-14", updatedAt: "2026-09-05T10:00:00.000Z" };
    const { result, rerender } = renderHook(
      ({ initialItems }) => useTimelineController({ initialItems: initialItems as never[], initialUnscheduled: [], workspaceId: "workspace-1" }),
      { initialProps: { initialItems: [original] } },
    );
    await act(() => result.current.reschedule("item-1", "LATER", "2026-10-01", "2026-10-14"));
    rerender({ initialItems: [{ ...original, updatedAt: "2026-09-05T13:00:00.000Z" }] });
    expect(result.current.items[0]).toMatchObject({ horizon: "LATER", viewStart: "2026-10-01" });
    expect(result.current.reconciliationRequiredIds).toContain("item-1");
  });

  it("accepts an exact local acknowledgement echo before later server state", async () => {
    actions.rescheduleRoadmapItem.mockResolvedValue(ack());
    const original = { id: "item-1", title: "Echo", horizon: "NEXT", squad: null, startDate: "2026-09-01", endDate: "2026-09-14", updatedAt: "2026-09-05T10:00:00.000Z" };
    const { result, rerender } = renderHook(
      ({ initialItems }) => useTimelineController({ initialItems: initialItems as never[], initialUnscheduled: [], workspaceId: "workspace-1" }),
      { initialProps: { initialItems: [original] } },
    );
    await act(() => result.current.reschedule("item-1", "LATER", "2026-10-01", "2026-10-14"));
    rerender({ initialItems: [{ ...original, horizon: "LATER", startDate: "2026-10-01T00:00:00.000Z", endDate: "2026-10-14T00:00:00.000Z", updatedAt: "2026-09-05T12:00:00.000Z" }] });
    rerender({ initialItems: [{ ...original, horizon: "SHIPPED", updatedAt: "2026-09-05T09:00:00.000Z" }] });
    expect(result.current.items[0].horizon).toBe("SHIPPED");
    expect(result.current.reconciliationRequiredIds).not.toContain("item-1");
  });

  it("treats a missing panel revision as invalidation without overwriting", () => {
    const initial = { id: "item-1", title: "Conflict", horizon: "NEXT", squad: null, startDate: "2026-09-01", endDate: "2026-09-14", updatedAt: "2026-09-05T10:00:00.000Z" };
    const { result } = renderHook(
      ({ initialItems }) => useTimelineController({ initialItems: initialItems as never[], initialUnscheduled: [], workspaceId: "workspace-1" }),
      { initialProps: { initialItems: [initial] } },
    );
    act(() => panel.listener?.("item-1", { horizon: "SHIPPED" }));
    expect(result.current.items[0].horizon).toBe("NEXT");
    expect(router.refresh).toHaveBeenCalled();
  });

  it("rejects a second mutation for the same item while its save is pending", async () => {
    let settle!: () => void;
    actions.rescheduleRoadmapItem.mockImplementation(() => new Promise((resolve) => { settle = () => resolve(ack("NEXT", "2026-10-01", "2026-10-14")); }));
    const { result } = renderHook(() => useTimelineController({
      initialItems: [{
        id: "item-1", title: "Move me", horizon: "NEXT", squad: null,
        startDate: "2026-09-01", endDate: "2026-09-14",
      } as never],
      initialUnscheduled: [],
      workspaceId: "workspace-1",
    }));

    let first!: Promise<void>;
    act(() => { first = result.current.reschedule("item-1", "NEXT", "2026-10-01", "2026-10-14"); });
    await expect(result.current.reschedule("item-1", "NEXT", "2026-11-01", "2026-11-14"))
      .rejects.toThrow("already being saved");
    expect(actions.rescheduleRoadmapItem).toHaveBeenCalledOnce();
    act(() => settle());
    await first;
  });

  it("rolls back without exposing raw server error details", async () => {
    actions.rescheduleRoadmapItem.mockRejectedValue(new Error("Prisma P2025: secret database detail"));
    const { result } = renderHook(() => useTimelineController({
      initialItems: [{
        id: "item-1", title: "Rollback", horizon: "NEXT", squad: null,
        startDate: "2026-09-01", endDate: "2026-09-14",
      } as never],
      initialUnscheduled: [],
      workspaceId: "workspace-1",
    }));

    await act(async () => {
      await expect(result.current.reschedule("item-1", "LATER", "2026-10-01", "2026-10-14"))
        .rejects.toThrow();
    });

    expect(result.current.items[0]).toMatchObject({ horizon: "NEXT", viewStart: "2026-09-01", viewEnd: "2026-09-14" });
    expect(result.current.announcement).toBe("Could not save Rollback to Later, 2026-10-01 through 2026-10-14. Changes rolled back; try again.");
    expect(result.current.announcement).not.toContain("Prisma");
  });

  it("keeps quick-add failures announced without leaking an unhandled rejection", async () => {
    const item = { kind: "feedback" as const, id: "feedback-1", title: "Rejected quick add" };
    actions.promoteFeedbackToRoadmap.mockRejectedValue(new Error("deterministic quick-add failure"));
    const { result } = renderHook(() => useTimelineController({
      initialItems: [],
      initialUnscheduled: [item],
      workspaceId: "workspace-1",
    }));

    act(() => result.current.quickAdd(item, "NEXT"));

    await waitFor(() => expect(result.current.announcement).toContain("Could not schedule Rejected quick add"));
    expect(actions.promoteFeedbackToRoadmap).toHaveBeenCalledOnce();
    expect(result.current.announcement).toBe("Could not schedule Rejected quick add. Try again.");
  });

  it("dispatches backlog promotion to Now", async () => {
    const item = { kind: "feedback" as const, id: "feedback-1", title: "Policy" };
    const { result } = renderHook(() => useTimelineController({ initialItems: [], initialUnscheduled: [item], workspaceId: "workspace-1" }));
    await act(() => result.current.scheduleBacklog(item, "NOW", "2026-09-04"));
    expect(actions.promoteFeedbackToRoadmap).toHaveBeenCalledOnce();
    expect(result.current.announcement).toBe("Policy scheduled for 14 days starting 2026-09-04");
  });

  it("renders pending backlog state and announces duplicate suppression deterministically", async () => {
    let settle!: () => void;
    actions.promoteFeedbackToRoadmap.mockImplementation(() => new Promise<void>((resolve) => { settle = resolve; }));
    const item = { kind: "feedback" as const, id: "feedback-1", title: "Pending backlog" };
    const { result } = renderHook(() => useTimelineController({ initialItems: [], initialUnscheduled: [item], workspaceId: "workspace-1" }));
    let first!: Promise<void>;
    act(() => { first = result.current.scheduleBacklog(item, "NEXT", "2026-09-04"); });
    expect(result.current.pendingBacklogIds).toEqual(new Set(["unscheduled:feedback:feedback-1"]));
    await act(() => result.current.scheduleBacklog(item, "NEXT", "2026-09-05"));
    expect(actions.promoteFeedbackToRoadmap).toHaveBeenCalledOnce();
    expect(result.current.announcement).toBe("Pending backlog is already being scheduled");
    act(() => settle());
    await first;
  });

  it("rolls a failed backlog command back to the newest refreshed backlog authority", async () => {
    let reject!: (error: Error) => void;
    actions.promoteFeedbackToRoadmap.mockImplementation(() => new Promise((_resolve, rejectPromise) => { reject = rejectPromise; }));
    const item = { kind: "feedback" as const, id: "feedback-1", title: "Original" };
    const { result, rerender } = renderHook(
      ({ initialUnscheduled }) => useTimelineController({ initialItems: [], initialUnscheduled, workspaceId: "workspace-1" }),
      { initialProps: { initialUnscheduled: [item] } },
    );
    let save!: Promise<void>;
    act(() => { save = result.current.scheduleBacklog(item, "NEXT", "2026-09-04"); });
    rerender({ initialUnscheduled: [{ ...item, title: "Refreshed" }] });
    expect(result.current.unscheduled[0].title).toBe("Original");
    act(() => reject(new Error("failed")));
    await act(async () => { await expect(save).rejects.toThrow("failed"); });
    expect(result.current.unscheduled[0].title).toBe("Refreshed");
  });

  it("does not resurrect a successful promotion when another pending backlog key fails", async () => {
    let resolveFirst!: () => void;
    let rejectSecond!: (error: Error) => void;
    actions.promoteFeedbackToRoadmap
      .mockImplementationOnce(() => new Promise<void>((resolve) => { resolveFirst = resolve; }))
      .mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectSecond = reject; }));
    const first = { kind: "feedback" as const, id: "feedback-1", title: "First" };
    const second = { kind: "feedback" as const, id: "feedback-2", title: "Second" };
    const initialUnscheduled = [first, second];
    const { result } = renderHook(() => useTimelineController({ initialItems: [], initialUnscheduled, workspaceId: "workspace-1" }));
    let firstSave!: Promise<void>;
    let secondSave!: Promise<void>;
    act(() => {
      firstSave = result.current.scheduleBacklog(first, "NEXT", "2026-09-04");
      secondSave = result.current.scheduleBacklog(second, "LATER", "2026-09-04");
    });
    await act(async () => { resolveFirst(); await firstSave; });
    expect(result.current.unscheduled.map((item) => item.id)).toEqual(["feedback-2"]);
    act(() => rejectSecond(new Error("failed")));
    await act(async () => { await expect(secondSave).rejects.toThrow("failed"); });
    expect(result.current.unscheduled.map((item) => item.id)).toEqual(["feedback-2"]);
  });
});
