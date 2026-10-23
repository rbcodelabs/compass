import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppPrismaClient, AppTransactionClient } from "./db";
import { setModules } from "../__tests__/helpers/modules";

// This file exercises the real table probe; the module stub stays (setModules), only the probe is real.
vi.unmock("@/lib/feature-tables");

import { workspaceUpdatesTablesExist } from "./feature-tables";
import {
  recordWorkspaceUpdate,
  resetWorkspaceUpdatesAvailabilityCache,
  withUpdatesTables,
  withWorkspaceUpdates,
  workspaceUpdatesAvailable,
  retryUpdatesTransaction,
} from "./workspace-updates-capture";

const tablesDb = (findFirst: ReturnType<typeof vi.fn>, extra: object = {}) =>
  ({
    workspaceUpdatesState: { findFirst },
    workspaceUpdateEvent: { findFirst },
    workspaceUpdatesReadState: { findFirst },
    ...extra,
  }) as unknown as AppPrismaClient;

beforeEach(() => resetWorkspaceUpdatesAvailabilityCache());
afterEach(() => vi.unstubAllEnvs());

describe("atomic update capture", () => {
  it("treats a missing table as absent, never an arbitrary outage", async () => {
    const findFirst = vi.fn().mockRejectedValue({ code: "P2021" });
    const db = tablesDb(findFirst);
    expect(await workspaceUpdatesTablesExist(db)).toBe(false);
    findFirst.mockRejectedValue(new Error("network down"));
    await expect(workspaceUpdatesTablesExist(db)).rejects.toThrow("network down");
  });
  it("is available only when the workspace has the module AND the tables exist", async () => {
    const present = tablesDb(vi.fn().mockResolvedValue(null));
    const absent = tablesDb(vi.fn().mockRejectedValue({ code: "P2021" }));

    setModules({ workspace_updates: true });
    expect(await workspaceUpdatesAvailable(present, "w")).toBe(true);
    resetWorkspaceUpdatesAvailabilityCache();
    expect(await workspaceUpdatesAvailable(absent, "w")).toBe(false);

    resetWorkspaceUpdatesAvailabilityCache();
    setModules({ workspace_updates: false });
    expect(await workspaceUpdatesAvailable(present, "w")).toBe(false);
  });
  it("does not even probe the tables when the module is off", async () => {
    setModules({ workspace_updates: false });
    const findFirst = vi.fn().mockRejectedValue(new Error("must not be called"));
    expect(await workspaceUpdatesAvailable(tablesDb(findFirst), "w")).toBe(false);
    expect(findFirst).not.toHaveBeenCalled();
  });
  it("retries rollback conflicts but never ambiguous network failures", async () => {
    const transaction = vi
      .fn()
      .mockRejectedValueOnce({ code: "P2034" })
      .mockResolvedValue("ok");
    const db = { $transaction: transaction } as unknown as AppPrismaClient;
    expect(await retryUpdatesTransaction(db, async () => "ok")).toBe("ok");
    expect(transaction).toHaveBeenCalledTimes(2);
    transaction
      .mockReset()
      .mockRejectedValue(new Error("connection lost during commit"));
    await expect(retryUpdatesTransaction(db, async () => "ok")).rejects.toThrow(
      "connection lost",
    );
    expect(transaction).toHaveBeenCalledTimes(1);
  });
  it("propagates event failure out of the atomic transaction", async () => {
    setModules({ workspace_updates: true });
    const findFirst = vi.fn().mockResolvedValue(null);
    const tx = {
      workspaceUpdatesState: {
        upsert: vi.fn().mockResolvedValue({ revision: 1 }),
      },
      workspaceUpdateEvent: {
        create: vi.fn().mockRejectedValue(new Error("event failed")),
      },
    } as unknown as AppTransactionClient;
    let committed = false;
    const db = tablesDb(findFirst, {
      $transaction: vi.fn(async (cb) => {
        const result = await cb(tx);
        committed = true;
        return result;
      }),
    });
    await expect(
      withWorkspaceUpdates(db, "w", async (tx) =>
        recordWorkspaceUpdate(tx, {
          workspaceId: "w",
          entityId: "e",
          entityType: "TASK",
          kind: "CREATED",
          actorType: "SYSTEM",
        }),
      ),
    ).rejects.toThrow("event failed");
    expect(committed).toBe(false);
  });
  it("leaves writes for a workspace with the module off independent of the migration", async () => {
    setModules({ workspace_updates: false });
    const db = {} as AppPrismaClient;
    expect(
      await withWorkspaceUpdates(db, "w", async (tx, capture) => ({
        same: tx === db,
        capture,
      })),
    ).toEqual({ same: true, capture: false });
  });
  it("opens the transaction for withUpdatesTables whenever the tables exist, and not otherwise", async () => {
    const transaction = vi.fn(async (cb: (tx: unknown) => unknown) => cb("tx"));
    const present = tablesDb(vi.fn().mockResolvedValue(null), { $transaction: transaction });
    expect(await withUpdatesTables(present, async (tx, exist) => ({ tx, exist }))).toEqual({ tx: "tx", exist: true });
    expect(transaction).toHaveBeenCalledTimes(1);

    resetWorkspaceUpdatesAvailabilityCache();
    const absent = tablesDb(vi.fn().mockRejectedValue({ code: "P2021" }), { $transaction: transaction });
    const result = await withUpdatesTables(absent, async (tx, exist) => ({ same: tx === absent, exist }));
    expect(result).toEqual({ same: true, exist: false });
    expect(transaction).toHaveBeenCalledTimes(1);
  });
  it("decides capture per workspace with the same tables present", async () => {
    const on = "00000000-0000-4000-8000-0000000000a1";
    const off = "00000000-0000-4000-8000-0000000000a2";
    const { isModuleEnabled } = await import("@/lib/modules/server");
    vi.mocked(isModuleEnabled).mockImplementation(async (workspaceId, key) => key === "workspace_updates" && workspaceId === on);
    try {
      const db = tablesDb(vi.fn().mockResolvedValue(null), {
        $transaction: vi.fn(async (cb: (tx: unknown) => unknown) => cb("tx")),
      });
      const seen = (workspaceId: string) => withWorkspaceUpdates(db, workspaceId, async (_tx, capture) => capture);
      expect(await seen(on)).toBe(true);
      expect(await seen(off)).toBe(false);
    } finally {
      vi.mocked(isModuleEnabled).mockReset();
    }
  });
  it("suppresses repeated status assignments", async () => {
    const tx = {} as AppTransactionClient;
    await expect(
      recordWorkspaceUpdate(tx, {
        workspaceId: "w",
        entityId: "e",
        entityType: "TASK",
        kind: "STATUS_CHANGED",
        actorType: "SYSTEM",
        before: "DONE",
        after: "DONE",
      }),
    ).resolves.toBeUndefined();
  });
  it("allocates revision and event on the supplied transaction", async () => {
    const upsert = vi.fn().mockResolvedValue({ revision: 9 });
    const create = vi.fn().mockResolvedValue({});
    const tx = {
      workspaceUpdatesState: { upsert },
      workspaceUpdateEvent: { create },
    } as unknown as AppTransactionClient;
    await recordWorkspaceUpdate(tx, {
      workspaceId: "w",
      entityId: "e",
      entityType: "TASK",
      kind: "CREATED",
      actorType: "USER",
      actorId: "u",
    });
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        revision: 9,
        workspaceId: "w",
        groupId: "e",
        groupType: "TASK",
        actorId: "u",
      }),
    });
  });
});
