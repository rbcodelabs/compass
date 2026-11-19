import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = { id: string; objectiveId: string; sortOrder: number; createdAt: number };
const db = vi.hoisted(() => ({ rows: [] as Row[], inTx: 0, writesOutsideTx: 0, failOnWrite: 0, writes: 0 }));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/product-action-auth", () => ({
  requireProductEntity: vi.fn().mockResolvedValue({ workspaceId: "ws-1", opportunityId: null }),
  requireProductWorkspace: vi.fn(),
  requireProductWorkspaceBySlug: vi.fn(),
}));
vi.mock("@/lib/db", () => {
  const keyResult = {
    findUnique: async ({ where }: { where: { id: string } }) => db.rows.find((r) => r.id === where.id) ?? null,
    findMany: async ({ where }: { where: { objectiveId: string } }) =>
      db.rows
        .filter((r) => r.objectiveId === where.objectiveId)
        .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt)
        .map((r) => ({ id: r.id, sortOrder: r.sortOrder })),
    update: async ({ where, data }: { where: { id: string }; data: { sortOrder: number } }) => {
      if (!db.inTx) db.writesOutsideTx++;
      db.writes++;
      if (db.failOnWrite && db.writes === db.failOnWrite) throw new Error("db down");
      db.rows.find((r) => r.id === where.id)!.sortOrder = data.sortOrder;
    },
  };
  const client = { keyResult };
  return {
    default: () => ({
      ...client,
      // Interactive transaction over the same fake; a throw rolls back to the snapshot.
      $transaction: async (fn: (tx: typeof client) => Promise<unknown>) => {
        const snapshot = db.rows.map((r) => ({ ...r }));
        db.inTx++;
        try {
          return await fn(client);
        } catch (e) {
          db.rows = snapshot;
          throw e;
        } finally {
          db.inTx--;
        }
      },
    }),
  };
});

import { reorderKeyResult } from "@/app/[orgSlug]/[workspaceSlug]/okrs/actions";

// What the cycle page does: ORDER BY sortOrder, createdAt.
const canonical = () =>
  [...db.rows].sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt).map((r) => r.id);

describe("reorderKeyResult", () => {
  beforeEach(() => {
    db.inTx = 0; db.writesOutsideTx = 0; db.failOnWrite = 0; db.writes = 0;
    db.rows = [
      { id: "A", objectiveId: "o1", sortOrder: 0, createdAt: 1 },
      { id: "B", objectiveId: "o1", sortOrder: 1, createdAt: 2 },
      { id: "C", objectiveId: "o1", sortOrder: 2, createdAt: 3 },
      { id: "X", objectiveId: "o2", sortOrder: 0, createdAt: 4 },
    ];
  });

  it("moving the last key result to the front persists C, A, B", async () => {
    await reorderKeyResult("C", 0, "/p");
    expect(canonical().filter((id) => id !== "X")).toEqual(["C", "A", "B"]);
  });

  it("moving the first key result down persists B, C, A", async () => {
    await reorderKeyResult("A", 2, "/p");
    expect(canonical().filter((id) => id !== "X")).toEqual(["B", "C", "A"]);
  });

  it("does not touch key results of other objectives", async () => {
    await reorderKeyResult("C", 0, "/p");
    expect(db.rows.find((r) => r.id === "X")!.sortOrder).toBe(0);
  });

  it("performs every renumber write inside one transaction", async () => {
    await reorderKeyResult("C", 0, "/p");
    expect(db.writes).toBeGreaterThan(0);
    expect(db.writesOutsideTx).toBe(0);
  });

  it("leaves the stored order untouched when a write fails midway", async () => {
    db.failOnWrite = 2;
    await expect(reorderKeyResult("C", 0, "/p")).rejects.toThrow("db down");
    expect(canonical().filter((id) => id !== "X")).toEqual(["A", "B", "C"]);
  });
});
