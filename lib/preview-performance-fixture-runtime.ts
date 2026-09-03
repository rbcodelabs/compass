import type { PrismaClient } from "@prisma/client";
import getPrisma from "@/lib/db";
import {
  CLEANUP_ORDER,
  FIXTURE_COUNTS,
  SEED_ORDER,
  buildDeterministicPreviewFixturePlan,
  createPreviewFixtureManifest,
  redactSensitiveText,
  type PreviewFixtureManifest,
  type PreviewFixtureKind,
  type PreviewFixturePlan,
} from "@/lib/preview-performance-fixture";
import { PrismaPreviewFixtureStore } from "@/lib/preview-performance-fixture-prisma";
import {
  PrismaRecoveryFixtureStore,
  isValidMonotonicSubset,
  type RecoveryFixtureInspection,
} from "@/lib/preview-performance-fixture-recovery";
import type { PreviewFixtureRequest } from "@/app/api/admin/performance-fixture/route";

const TOTAL_ROWS = Object.values(FIXTURE_COUNTS).reduce((total, count) => total + count, 0);

export function hasExactRuntimeSentinels(
  counts: Record<PreviewFixtureKind, number>,
  sentinelTotal: number,
): boolean {
  return sentinelTotal === counts.users + counts.organizations + counts.workspaces;
}

export interface RuntimeFixtureInspection extends RecoveryFixtureInspection {
  complete: boolean;
}

export interface RuntimeFixtureTransaction {
  seed(plan: PreviewFixturePlan): Promise<void>;
}

export interface RuntimeFixtureStore {
  inspect(manifest: PreviewFixtureManifest, plan?: PreviewFixturePlan, mode?: "ownership" | "seed-credentials"): Promise<RuntimeFixtureInspection>;
  transaction(operation: (transaction: RuntimeFixtureTransaction) => Promise<void>): Promise<void>;
  cleanup(manifest: PreviewFixtureManifest, plan: PreviewFixturePlan): Promise<void>;
}

export function buildRuntimeFixturePlan(input: PreviewFixtureRequest): PreviewFixturePlan {
  if (input.action !== "seed" || !input.sessionToken) throw new Error("Seed input is required to build the runtime fixture plan");
  return buildDeterministicPreviewFixturePlan({
    runId: input.runId,
    deploymentSha: input.expectedSha,
    deploymentId: input.expectedDeploymentId,
    deploymentUrl: `https://${process.env.VERCEL_URL ?? "invalid.example"}`,
    expiresAt: new Date(input.expiresAt),
    sessionToken: input.sessionToken,
  });
}

function stateFor(input: PreviewFixtureRequest): { manifest: PreviewFixtureManifest; plan: PreviewFixturePlan } {
  // Cleanup and verify never need the real token; this placeholder is not stored
  // or compared and only allows deterministic reconstruction of the server graph.
  const plan = buildRuntimeFixturePlan({ ...input, action: "seed", sessionToken: input.sessionToken ?? "x".repeat(64) });
  return { manifest: createPreviewFixtureManifest(plan), plan };
}

export async function executePreviewFixtureActionWithStore(
  input: PreviewFixtureRequest,
  store: RuntimeFixtureStore,
): Promise<{ state: "seeded" | "absent"; residue: number; replayed?: boolean }> {
  if (input.action === "preflight") throw new Error("Preflight must return before fixture runtime execution");
  const { manifest, plan } = stateFor(input);
  const inspectionMode = input.action === "seed" ? "seed-credentials" : "ownership";
  const before = await store.inspect(manifest, plan, inspectionMode);
  if (!before.exact) throw new Error("Preview fixture recovery required");
  if (input.action === "seed" && before.total !== 0 && !before.complete) throw new Error("Preview fixture recovery required");
  if (input.action !== "seed" && !isValidMonotonicSubset(before)) throw new Error("Preview fixture recovery required");

  if (input.action === "verify") {
    return { state: before.total === 0 ? "absent" : "seeded", residue: before.total };
  }
  if (input.action === "seed" && before.complete) {
    return { state: "seeded", residue: before.total, replayed: true };
  }
  if (input.action === "cleanup" && before.total === 0) {
    return { state: "absent", residue: 0, replayed: true };
  }

  try {
    if (input.action === "seed") {
      await store.transaction(async (transaction) => transaction.seed(buildRuntimeFixturePlan(input)));
    } else {
      await store.cleanup(manifest, plan);
    }
  } catch {
    const afterFailure = await store.inspect(manifest, plan, inspectionMode);
    if (input.action === "seed" && afterFailure.complete && afterFailure.exact) {
      return { state: "seeded", residue: afterFailure.total, replayed: true };
    }
    const token = input.sessionToken;
    throw new Error(redactSensitiveText("Preview fixture transaction failed; recovery required", [token]), { cause: undefined });
  }

  const after = await store.inspect(manifest, plan, inspectionMode);
  if (input.action === "seed" && after.complete && after.exact && after.total === TOTAL_ROWS) {
    return { state: "seeded", residue: after.total, replayed: false };
  }
  if (input.action === "cleanup" && after.exact && after.total === 0) {
    return { state: "absent", residue: 0, replayed: false };
  }
  throw new Error("Preview fixture post-transaction verification failed; recovery required");
}

export class PrismaRuntimeFixtureStore implements RuntimeFixtureStore {
  private readonly prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  async inspect(manifest: PreviewFixtureManifest, plan?: PreviewFixturePlan, mode: "ownership" | "seed-credentials" = "ownership"): Promise<RuntimeFixtureInspection> {
    const store = new PrismaPreviewFixtureStore(this.prisma);
    const counts = await store.countPlannedRowsByKind(manifest);
    const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
    const sentinelTotal = await store.countSentinelRows(manifest);
    if (total === 0) return { counts, total, sentinelTotal, complete: false, exact: sentinelTotal === 0 };
    try {
      await store.verifyOwnership(manifest);
      if (!plan) return { counts, total, sentinelTotal, complete: false, exact: false };
      await store.verifyExactRows(plan, mode === "seed-credentials");
      const exact = hasExactRuntimeSentinels(counts, sentinelTotal);
      return { counts, total, sentinelTotal, complete: exact && total === TOTAL_ROWS, exact };
    } catch {
      return { counts, total, sentinelTotal, complete: false, exact: false };
    }
  }

  async transaction(operation: (transaction: RuntimeFixtureTransaction) => Promise<void>): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const store = new PrismaPreviewFixtureStore(tx);
      await operation({
        seed: async (plan) => {
          const manifest = createPreviewFixtureManifest(plan);
          if (await store.countPlannedRows(manifest) !== 0 || await store.countSentinelRows(manifest) !== 0) {
            throw new Error("Preview fixture changed before seed transaction");
          }
          for (const kind of SEED_ORDER) await store.insert(kind, plan.rows[kind]);
        },
      });
    }, { maxWait: 10_000, timeout: 300_000 });
  }

  async cleanup(manifest: PreviewFixtureManifest, plan: PreviewFixturePlan): Promise<void> {
    const store = new PrismaRecoveryFixtureStore(this.prisma);
    for (const kind of CLEANUP_ORDER) {
      const ids = manifest.plannedIds[kind];
      for (let offset = 0; offset < ids.length; offset += 100) {
        await store.deleteChunk(kind, ids.slice(offset, offset + 100), manifest, plan);
      }
    }
  }
}

export async function executePreviewFixtureAction(input: PreviewFixtureRequest) {
  return executePreviewFixtureActionWithStore(input, new PrismaRuntimeFixtureStore(getPrisma()));
}
