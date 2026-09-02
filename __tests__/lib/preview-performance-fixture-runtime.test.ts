import { describe, expect, it } from "vitest";
import {
  buildRuntimeFixturePlan,
  executePreviewFixtureActionWithStore,
  type RuntimeFixtureStore,
} from "@/lib/preview-performance-fixture-runtime";
import { FIXTURE_COUNTS, SEED_ORDER, type PreviewFixtureManifest } from "@/lib/preview-performance-fixture";

const SHA = "a".repeat(40);
const DEPLOYMENT_ID = `dpl_${"A".repeat(24)}`;
const RUN_ID = `perf_preview_${"b".repeat(32)}`;

function input(action: "seed" | "cleanup" | "verify", sessionToken?: string) {
  return {
    action,
    runId: RUN_ID,
    expectedSha: SHA,
    expectedDeploymentId: DEPLOYMENT_ID,
    expiresAt: new Date(Date.now() + 20 * 60_000).toISOString(),
    ...(sessionToken ? { sessionToken } : {}),
  };
}

function mutableStore(initial = 0): RuntimeFixtureStore & { transactionCount: number; residue: number } {
  const value = {
    transactionCount: 0,
    residue: initial,
    async inspect(manifest: PreviewFixtureManifest) {
      void manifest;
      return { total: value.residue, complete: value.residue === 1231, exact: value.residue === 0 || value.residue === 1231 };
    },
    async transaction(operation: Parameters<RuntimeFixtureStore["transaction"]>[0]) {
      value.transactionCount += 1;
      await operation({
        seed: async () => { value.residue = 1231; },
        cleanup: async () => { value.residue = 0; },
      });
    },
  };
  return value;
}

describe("preview performance fixture runtime", () => {
  it("derives stable domain-separated UUIDs and the complete 1,231-row graph", () => {
    const request = input("seed", "s".repeat(64));
    const first = buildRuntimeFixturePlan(request);
    const second = buildRuntimeFixturePlan(request);
    expect(first.rows).toEqual(second.rows);
    expect(SEED_ORDER.reduce((total, kind) => total + first.rows[kind].length, 0)).toBe(1231);
    expect(new Set(SEED_ORDER.flatMap((kind) => first.rows[kind].map(({ id }) => id))).size).toBe(1231);
    expect(first.rows.users).toHaveLength(FIXTURE_COUNTS.users);
  });

  it("seeds the graph in one transaction and verifies the fresh outcome", async () => {
    const fixtureStore = mutableStore();
    const result = await executePreviewFixtureActionWithStore(input("seed", "s".repeat(64)), fixtureStore);
    expect(fixtureStore.transactionCount).toBe(1);
    expect(result).toMatchObject({ state: "seeded", residue: 1231, replayed: false });
  });

  it("treats a complete exact seed replay as no-write success", async () => {
    const fixtureStore = mutableStore(1231);
    const result = await executePreviewFixtureActionWithStore(input("seed", "s".repeat(64)), fixtureStore);
    expect(fixtureStore.transactionCount).toBe(0);
    expect(result).toMatchObject({ state: "seeded", replayed: true });
  });

  it("refuses partial or ownership-mismatched state without mutation", async () => {
    for (const fixtureStore of [mutableStore(1), mutableStore(12)]) {
      await expect(executePreviewFixtureActionWithStore(input("seed", "s".repeat(64)), fixtureStore)).rejects.toThrow("recovery required");
      expect(fixtureStore.transactionCount).toBe(0);
    }
  });

  it("cleans in one transaction and a separate verify proves zero residue", async () => {
    const fixtureStore = mutableStore(1231);
    const cleaned = await executePreviewFixtureActionWithStore(input("cleanup"), fixtureStore);
    expect(cleaned).toMatchObject({ state: "absent", residue: 0 });
    expect(fixtureStore.transactionCount).toBe(1);
    const verified = await executePreviewFixtureActionWithStore(input("verify"), fixtureStore);
    expect(verified).toMatchObject({ state: "absent", residue: 0 });
    expect(fixtureStore.transactionCount).toBe(1);
  });

  it("never includes the session token in results or sanitized failures", async () => {
    const token = "t".repeat(64);
    const fixtureStore = mutableStore();
    fixtureStore.transaction = async () => { throw new Error(`database failed ${token}`); };
    await expect(executePreviewFixtureActionWithStore(input("seed", token), fixtureStore)).rejects.not.toThrow(token);
  });
});
