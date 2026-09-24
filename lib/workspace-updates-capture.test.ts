import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppPrismaClient, AppTransactionClient } from "./db";
import {
  recordWorkspaceUpdate,
  withWorkspaceUpdates,
  workspaceUpdatesAvailable,
  retryUpdatesTransaction,
} from "./workspace-updates-capture";
afterEach(() => vi.unstubAllEnvs());
describe("atomic update capture", () => {
  it("falls back only for missing schema, never for an arbitrary outage", async () => {
    vi.stubEnv("WORKSPACE_UPDATES_ENABLED", "1");
    const findFirst = vi.fn().mockRejectedValue({ code: "P2021" });
    const db = {
      workspaceUpdatesState: { findFirst },
      workspaceUpdateEvent: { findFirst },
      workspaceUpdatesReadState: { findFirst },
    } as unknown as AppPrismaClient;
    expect(await workspaceUpdatesAvailable(db)).toBe(false);
    findFirst.mockRejectedValue(new Error("network down"));
    await expect(workspaceUpdatesAvailable(db)).rejects.toThrow("network down");
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
    vi.stubEnv("WORKSPACE_UPDATES_ENABLED", "1");
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
    const db = {
      workspaceUpdatesState: { findFirst },
      workspaceUpdateEvent: { findFirst },
      workspaceUpdatesReadState: { findFirst },
      $transaction: vi.fn(async (cb) => {
        const result = await cb(tx);
        committed = true;
        return result;
      }),
    } as unknown as AppPrismaClient;
    await expect(
      withWorkspaceUpdates(db, async (tx) =>
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
  it("leaves disabled mutations independent of the migration", async () => {
    vi.stubEnv("WORKSPACE_UPDATES_ENABLED", "0");
    const db = {} as AppPrismaClient;
    expect(
      await withWorkspaceUpdates(db, async (tx, capture) => ({
        same: tx === db,
        capture,
      })),
    ).toEqual({ same: true, capture: false });
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
