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
  type PreviewFixturePlan,
} from "@/lib/preview-performance-fixture";
import { PrismaPreviewFixtureStore } from "@/lib/preview-performance-fixture-prisma";
import type { PreviewFixtureRequest } from "@/app/api/admin/performance-fixture/route";

const TOTAL_ROWS = Object.values(FIXTURE_COUNTS).reduce((total, count) => total + count, 0);

export interface RuntimeFixtureInspection {
  total: number;
  complete: boolean;
  exact: boolean;
}

export interface RuntimeFixtureTransaction {
  seed(plan: PreviewFixturePlan): Promise<void>;
  cleanup(manifest: PreviewFixtureManifest): Promise<void>;
}

export interface RuntimeFixtureStore {
  inspect(manifest: PreviewFixtureManifest, plan?: PreviewFixturePlan, mode?: "ownership" | "seed-credentials"): Promise<RuntimeFixtureInspection>;
  transaction(operation: (transaction: RuntimeFixtureTransaction) => Promise<void>): Promise<void>;
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
  const { manifest, plan } = stateFor(input);
  const inspectionMode = input.action === "seed" ? "seed-credentials" : "ownership";
  const before = await store.inspect(manifest, plan, inspectionMode);
  if (!before.exact || (before.total !== 0 && !before.complete)) throw new Error("Preview fixture recovery required");

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
    await store.transaction(async (transaction) => {
      if (input.action === "seed") await transaction.seed(buildRuntimeFixturePlan(input));
      else await transaction.cleanup(manifest);
    });
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
    const total = await store.countPlannedRows(manifest);
    const sentinelTotal = await store.countSentinelRows(manifest);
    if (total === 0) return { total, complete: false, exact: sentinelTotal === 0 };
    try {
      await store.verifyOwnership(manifest);
      if (!plan) return { total, complete: false, exact: false };
      await store.verifyExactRows(plan, mode === "seed-credentials");
      return { total, complete: total === TOTAL_ROWS, exact: total === TOTAL_ROWS && sentinelTotal === 12 };
    } catch {
      return { total, complete: false, exact: false };
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
        cleanup: async (manifest) => {
          await store.verifyOwnership(manifest);
          const plan = stateFor(inputForManifest(manifest)).plan;
          await store.verifyExactRows(plan);
          if (await store.countPlannedRows(manifest) !== TOTAL_ROWS || await store.countSentinelRows(manifest) !== 12) {
            throw new Error("Preview fixture changed before cleanup transaction");
          }
          for (const kind of CLEANUP_ORDER) await store.deleteIds(kind, manifest.plannedIds[kind]);
        },
      });
    }, { maxWait: 10_000, timeout: 300_000 });
  }
}

function inputForManifest(manifest: PreviewFixtureManifest): PreviewFixtureRequest {
  return {
    action: "cleanup",
    runId: manifest.identity.runId,
    expectedSha: manifest.identity.deploymentSha,
    expectedDeploymentId: manifest.identity.deploymentId,
    expiresAt: manifest.identity.expiresAt,
  };
}

export async function executePreviewFixtureAction(input: PreviewFixtureRequest) {
  return executePreviewFixtureActionWithStore(input, new PrismaRuntimeFixtureStore(getPrisma()));
}
