import { describe, expect, it } from "vitest";
import fs from "node:fs";
import {
  RECOVERY_CHUNK_SIZE,
  SOURCE_FIXTURE_IDENTITY,
  executePreviewFixtureRecoveryWithStore,
  type RecoveryFixtureInspection,
  type RecoveryFixtureStore,
} from "@/lib/preview-performance-fixture-recovery";
import { CLEANUP_ORDER, FIXTURE_COUNTS, type PreviewFixtureKind } from "@/lib/preview-performance-fixture";

function fullCounts(): Record<PreviewFixtureKind, number> {
  return Object.fromEntries(CLEANUP_ORDER.map((kind) => [kind, FIXTURE_COUNTS[kind]])) as Record<PreviewFixtureKind, number>;
}

function storeWithCounts(initial = fullCounts()): RecoveryFixtureStore & { calls: Array<{ kind: PreviewFixtureKind; size: number }>; inspections: number } {
  const counts = { ...initial };
  const store = {
    calls: [] as Array<{ kind: PreviewFixtureKind; size: number }>,
    inspections: 0,
    async inspect(): Promise<RecoveryFixtureInspection> {
      store.inspections += 1;
      const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
      return { counts: { ...counts }, total, sentinelTotal: counts.users + counts.organizations + counts.workspaces, exact: true };
    },
    async deleteChunk(kind: PreviewFixtureKind, ids: readonly string[]) {
      store.calls.push({ kind, size: ids.length });
      const affected = Math.min(counts[kind], ids.length);
      counts[kind] -= affected;
      return affected;
    },
  };
  return store;
}

describe("emergency preview fixture recovery", () => {
  it("is permanently bound to the stranded source identity", () => {
    expect(SOURCE_FIXTURE_IDENTITY).toEqual({
      runId: "perf_preview_7389674e8e553c70cc9104450ae574d0",
      deploymentSha: "9b646481eee6b7eba71c93981d56e292636c4260",
      deploymentId: "dpl_52pkLvUGkTkpPZgR9NeRwDekU75d",
      deploymentUrl: "https://compass-gjvp34s9v-rbcodelabs-team.vercel.app/",
    });
  });

  it("deletes in dependency order in deterministic chunks of at most 100", async () => {
    const store = storeWithCounts();
    await expect(executePreviewFixtureRecoveryWithStore("cleanup", store)).resolves.toEqual({ state: "absent", residue: 0 });
    expect(store.calls.every(({ size }) => size <= RECOVERY_CHUNK_SIZE)).toBe(true);
    expect([...new Set(store.calls.map(({ kind }) => kind))]).toEqual(CLEANUP_ORDER);
    expect(store.inspections).toBe(2);
  });

  it("resumes after interruption from a valid monotonic subset", async () => {
    const store = storeWithCounts();
    let calls = 0;
    const original = store.deleteChunk;
    store.deleteChunk = async (...args) => {
      if (++calls === 4) throw new Error("interrupted");
      return original(...args);
    };
    await expect(executePreviewFixtureRecoveryWithStore("cleanup", store)).rejects.toThrow("recovery required");
    store.deleteChunk = original;
    await expect(executePreviewFixtureRecoveryWithStore("cleanup", store)).resolves.toEqual({ state: "absent", residue: 0 });
  });

  it("blocks non-monotonic, mismatched, and sentinel-collision state before deletion", async () => {
    const nonMonotonic = fullCounts();
    nonMonotonic.roadmapItems = 0;
    nonMonotonic.evidence = FIXTURE_COUNTS.evidence - 1;
    nonMonotonic.experiments = 0;
    const first = storeWithCounts(nonMonotonic);
    await expect(executePreviewFixtureRecoveryWithStore("cleanup", first)).rejects.toThrow("recovery required");
    expect(first.calls).toEqual([]);
    const collision = storeWithCounts();
    const inspect = collision.inspect;
    collision.inspect = async (...args) => ({ ...(await inspect(...args)), sentinelTotal: 13 });
    await expect(executePreviewFixtureRecoveryWithStore("cleanup", collision)).rejects.toThrow("recovery required");
    expect(collision.calls).toEqual([]);
  });

  it("requires independent planned-ID and sentinel zero proof", async () => {
    const absent = Object.fromEntries(CLEANUP_ORDER.map((kind) => [kind, 0])) as Record<PreviewFixtureKind, number>;
    await expect(executePreviewFixtureRecoveryWithStore("verify", storeWithCounts(absent))).resolves.toEqual({ state: "absent", residue: 0 });
    const collision = storeWithCounts(absent);
    collision.inspect = async () => ({ counts: absent, total: 0, sentinelTotal: 1, exact: false });
    await expect(executePreviewFixtureRecoveryWithStore("verify", collision)).rejects.toThrow("recovery required");
  });

  it("keeps each Prisma transaction scoped to the current chunk instead of rescanning the 1,231-row graph", async () => {
    let queries = 0;
    let directDelete: { sql?: string; text?: string; values?: unknown[] } | undefined;
    const row = { id: "row-1", workspaceId: "workspace-1" };
    const delegate = {
      findMany: async () => { queries += 1; return [row]; },
      count: async () => { queries += 1; return 1; },
      deleteMany: async () => { throw new Error("Prisma relation emulation must not run"); },
    };
    const executeRaw = async (query: { sql?: string; text?: string; values?: unknown[] }) => { queries += 1; directDelete = query; return 1; };
    const prisma = {
      roadmapItem: delegate,
      $transaction: async (callback: (tx: { roadmapItem: typeof delegate; $executeRaw: typeof executeRaw }) => Promise<number>) => callback({ roadmapItem: delegate, $executeRaw: executeRaw }),
    };
    const { PrismaRecoveryFixtureStore } = await import("@/lib/preview-performance-fixture-recovery");
    const store = new PrismaRecoveryFixtureStore(prisma as never);
    const plan = {
      rows: { roadmapItems: [row] },
    };
    const manifest = { plannedIds: { roadmapItems: [row.id] } };
    await expect(store.deleteChunk("roadmapItems", [row.id], manifest as never, plan as never)).resolves.toBe(1);
    expect(queries).toBe(4);
    expect(directDelete?.text ?? directDelete?.sql).toContain('DELETE FROM "compass_preview"."roadmap_items"');
    expect(directDelete?.values).toEqual([row.id]);
  });

  it("does not open a transaction for an already-absent retry chunk", async () => {
    let transactions = 0;
    const prisma = {
      roadmapItem: { count: async () => 0 },
      $transaction: async () => { transactions += 1; throw new Error("must not start"); },
    };
    const { PrismaRecoveryFixtureStore } = await import("@/lib/preview-performance-fixture-recovery");
    const store = new PrismaRecoveryFixtureStore(prisma as never);
    await expect(store.deleteChunk("roadmapItems", ["absent"], {} as never, {} as never)).resolves.toBe(0);
    expect(transactions).toBe(0);
  });

  it("still blocks a changed chunk row inside the transaction before deletion", async () => {
    let deletes = 0;
    const root = { count: async () => 1 };
    const transaction = {
      findMany: async () => [{ id: "row-1", workspaceId: "other-workspace" }],
      count: async () => 1,
      deleteMany: async () => { throw new Error("Prisma relation emulation must not run"); },
    };
    const executeRaw = async () => { deletes += 1; return 1; };
    const prisma = {
      roadmapItem: root,
      $transaction: async (callback: (tx: { roadmapItem: typeof transaction; $executeRaw: typeof executeRaw }) => Promise<number>) => callback({ roadmapItem: transaction, $executeRaw: executeRaw }),
    };
    const { PrismaRecoveryFixtureStore } = await import("@/lib/preview-performance-fixture-recovery");
    const store = new PrismaRecoveryFixtureStore(prisma as never);
    const plan = { rows: { roadmapItems: [{ id: "row-1", workspaceId: "expected-workspace" }] } };
    await expect(store.deleteChunk("roadmapItems", ["row-1"], {} as never, plan as never)).rejects.toThrow(/ownership mismatch/);
    expect(deletes).toBe(0);
  });

  it("maps every fixture kind to its physical Prisma table", async () => {
    const models: Record<PreviewFixtureKind, string> = {
      users: "User", organizations: "Organization", organizationMembers: "OrganizationMember",
      workspaces: "Workspace", workspaceMembers: "WorkspaceMember", squads: "Squad",
      okrCycles: "OKRCycle", objectives: "Objective", keyResults: "KeyResult",
      opportunities: "Opportunity", solutions: "Solution", assumptions: "Assumption",
      evidence: "Evidence", experiments: "Experiment", roadmapItems: "RoadmapItem",
      feedback: "FeedbackItem", tasks: "Task", sessions: "Session",
    };
    const schema = fs.readFileSync("prisma/schema.prisma", "utf8");
    const statements: string[] = [];
    const prisma = { $executeRaw: async (query: { text?: string; sql?: string }) => { statements.push(query.text ?? query.sql ?? ""); return 1; } };
    const { PrismaPreviewFixtureStore } = await import("@/lib/preview-performance-fixture-prisma");
    const store = new PrismaPreviewFixtureStore(prisma as never);
    for (const kind of CLEANUP_ORDER) {
      const block = schema.match(new RegExp(`model ${models[kind]} \\{[\\s\\S]*?\\n\\}`))?.[0];
      const table = block?.match(/@@map\("([^"]+)"\)/)?.[1];
      expect(table, `missing schema mapping for ${kind}`).toBeTruthy();
      await store.deleteIdsDirectWithCount(kind, ["00000000-0000-4000-8000-000000000001"]);
      expect(statements.at(-1)).toContain(`"compass_preview"."${table}"`);
    }
  });
});
