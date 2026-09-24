import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { AppPrismaClient } from "./db";
import {
  getUpdatesPage,
  markUpdatesCaughtUp,
  undoUpdatesCaughtUp,
} from "./workspace-updates";
import { signUpdatesToken } from "./workspace-updates-token";
vi.mock("./workspace-updates-sources", () => ({
  resolveUpdateSources: vi.fn(async (_tx, _workspace, rows) => rows),
}));
const baseline = new Date("2026-09-01T00:00:00Z");
function database() {
  let state = {
    id: "s",
    workspaceId: "w",
    userId: "u",
    caughtUpRevision: 0,
    previousRevision: null as number | null,
    version: "00000000-0000-0000-0000-000000000000",
    baselineAt: baseline,
  };
  const db = {
    workspaceUpdatesState: {
      findFirst: vi.fn().mockResolvedValue({}),
      findUnique: vi.fn().mockResolvedValue({ revision: 12 }),
    },
    workspaceUpdateEvent: {
      findFirst: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([]),
    },
    workspaceUpdatesReadState: {
      findFirst: vi.fn().mockResolvedValue({}),
      findUnique: vi.fn(async () => ({ ...state })),
      create: vi.fn(),
      updateMany: vi.fn(async ({ where, data }) => {
        if (where.version !== state.version) return { count: 0 };
        state = { ...state, ...data };
        return { count: 1 };
      }),
    },
    $transaction: vi.fn(async (callback) => callback(db)),
  };
  return {
    db: db as unknown as AppPrismaClient,
    raw: db,
    getState: () => state,
  };
}
const snapshot = (complete = true) =>
  signUpdatesToken({
    workspaceId: "w",
    userId: "u",
    upper: 10,
    before: 0,
    mode: "unread",
    baseline: baseline.toISOString(),
    readRevision: 0,
    complete,
  });
beforeEach(() => {
  vi.stubEnv("WORKSPACE_UPDATES_ENABLED", "1");
  vi.stubEnv("AUTH_SECRET", "synthetic-test-secret");
});
afterEach(() => vi.unstubAllEnvs());
describe("workspace catch-up state", () => {
  it("rejects a stale snapshot after another tab restores previously read updates", async () => {
    const { db } = database();
    const stale = signUpdatesToken({
      workspaceId: "w",
      userId: "u",
      upper: 12,
      before: 0,
      mode: "unread",
      baseline: baseline.toISOString(),
      readRevision: 10,
      complete: true,
    });
    await expect(markUpdatesCaughtUp(db, "w", "u", stale)).rejects.toThrow(
      "Catch-up changed",
    );
  });
  it("marks only the loaded snapshot, preserving events that arrived later", async () => {
    const { db, getState } = database();
    const result = await markUpdatesCaughtUp(db, "w", "u", snapshot());
    expect(result.readRevision).toBe(10);
    expect(getState().caughtUpRevision).toBe(10);
  });
  it("requires a fully loaded unread snapshot", async () => {
    const { db } = database();
    await expect(
      markUpdatesCaughtUp(db, "w", "u", snapshot(false)),
    ).rejects.toThrow("Load all");
  });
  it("rotates same-revision marks and refuses stale Undo", async () => {
    const { db } = database();
    const first = await markUpdatesCaughtUp(db, "w", "u", snapshot());
    const second = await markUpdatesCaughtUp(db, "w", "u", snapshot());
    expect(first.receipt).not.toBe(second.receipt);
    await expect(
      undoUpdatesCaughtUp(db, "w", "u", first.receipt),
    ).rejects.toThrow("another tab");
    expect(await undoUpdatesCaughtUp(db, "w", "u", second.receipt)).toEqual({
      readRevision: 10,
    });
  });
  it("restores server-stored prior state and consumes the receipt", async () => {
    const { db } = database();
    const { receipt } = await markUpdatesCaughtUp(db, "w", "u", snapshot());
    expect(await undoUpdatesCaughtUp(db, "w", "u", receipt)).toEqual({
      readRevision: 0,
    });
    await expect(undoUpdatesCaughtUp(db, "w", "u", receipt)).rejects.toThrow();
  });
  it("persists the first visit baseline instead of aging unread work out", async () => {
    const { db, raw } = database();
    await getUpdatesPage(db, "w", "u", "/org/ws", "unread");
    expect(raw.workspaceUpdateEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ createdAt: { gte: baseline } }),
      }),
    );
    expect(raw.workspaceUpdatesReadState.updateMany).not.toHaveBeenCalled();
  });
  it("freezes pagination upper revision and forbids mark until final page", async () => {
    const { db, raw } = database();
    raw.workspaceUpdateEvent.findMany.mockResolvedValue(
      Array.from({ length: 101 }, (_, i) => ({
        id: `e${i}`,
        revision: 200 - i,
      })),
    );
    raw.workspaceUpdatesState.findUnique.mockResolvedValue({ revision: 200 });
    const first = await getUpdatesPage(db, "w", "u", "/org/ws", "unread");
    expect(first.markToken).toBeNull();
    raw.workspaceUpdatesState.findUnique.mockResolvedValue({ revision: 201 });
    raw.workspaceUpdateEvent.findMany.mockResolvedValue([]);
    const second = await getUpdatesPage(
      db,
      "w",
      "u",
      "/org/ws",
      "unread",
      first.cursor!,
    );
    expect(second.snapshotRevision).toBe(200);
    expect(second.markToken).not.toBeNull();
    expect(raw.workspaceUpdateEvent.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          revision: { lte: 200, lt: 101, gt: 0 },
        }),
      }),
    );
  });
});
