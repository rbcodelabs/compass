import { describe, expect, it } from "vitest";
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

function storeWithCounts(initial = fullCounts()): RecoveryFixtureStore & { calls: Array<{ kind: PreviewFixtureKind; size: number }> } {
  const counts = { ...initial };
  const store = {
    calls: [] as Array<{ kind: PreviewFixtureKind; size: number }>,
    async inspect(): Promise<RecoveryFixtureInspection> {
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
});
