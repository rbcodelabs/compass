import crypto from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import getPrisma from "@/lib/db";
import {
  CLEANUP_ORDER,
  FIXTURE_COUNTS,
  SEED_ORDER,
  buildPreviewFixturePlan,
  createPreviewFixtureManifest,
  redactSensitiveText,
  type PreviewFixtureManifest,
  type PreviewFixturePlan,
} from "@/lib/preview-performance-fixture";
import { PrismaPreviewFixtureStore } from "@/lib/preview-performance-fixture-prisma";
import type { PreviewFixtureRequest } from "@/app/api/admin/performance-fixture/route";

const FIXTURE_VERSION = "preview-performance-v2";
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
  inspect(manifest: PreviewFixtureManifest, plan?: PreviewFixturePlan): Promise<RuntimeFixtureInspection>;
  transaction(operation: (transaction: RuntimeFixtureTransaction) => Promise<void>): Promise<void>;
}

function deterministicUuid(domain: string): string {
  const bytes = crypto.createHash("sha256").update(domain).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function deterministicIds(input: PreviewFixtureRequest): string[] {
  return SEED_ORDER.flatMap((kind) => Array.from({ length: FIXTURE_COUNTS[kind] }, (_, ordinal) =>
    deterministicUuid([FIXTURE_VERSION, input.expectedSha, input.expectedDeploymentId, input.runId, kind, ordinal].join("\0"))));
}

export function buildRuntimeFixturePlan(input: PreviewFixtureRequest): PreviewFixturePlan {
  if (input.action !== "seed" || !input.sessionToken) throw new Error("Seed input is required to build the runtime fixture plan");
  const ids = deterministicIds(input);
  let cursor = 0;
  const expiresAt = new Date(input.expiresAt);
  return buildPreviewFixturePlan({
    runId: input.runId,
    deploymentSha: input.expectedSha,
    deploymentId: input.expectedDeploymentId,
    deploymentUrl: `https://${process.env.VERCEL_URL ?? "invalid.example"}`,
    schema: "compass_preview",
    createdAt: new Date(expiresAt.getTime() - 20 * 60_000),
    expiresAt,
    sessionToken: input.sessionToken,
    idFactory: () => ids[cursor++],
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
  const before = await store.inspect(manifest, plan);
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
    const afterFailure = await store.inspect(manifest, plan);
    if (input.action === "seed" && afterFailure.complete && afterFailure.exact) {
      return { state: "seeded", residue: afterFailure.total, replayed: true };
    }
    const token = input.sessionToken;
    throw new Error(redactSensitiveText("Preview fixture transaction failed; recovery required", [token]), { cause: undefined });
  }

  const after = await store.inspect(manifest, plan);
  if (input.action === "seed" && after.complete && after.exact && after.total === TOTAL_ROWS) {
    return { state: "seeded", residue: after.total, replayed: false };
  }
  if (input.action === "cleanup" && after.exact && after.total === 0) {
    return { state: "absent", residue: 0, replayed: false };
  }
  throw new Error("Preview fixture post-transaction verification failed; recovery required");
}

class PrismaRuntimeFixtureStore implements RuntimeFixtureStore {
  constructor(private readonly prisma: PrismaClient) {}

  async inspect(manifest: PreviewFixtureManifest, plan?: PreviewFixturePlan): Promise<RuntimeFixtureInspection> {
    const store = new PrismaPreviewFixtureStore(this.prisma);
    const total = await store.countPlannedRows(manifest);
    const sentinelTotal = await store.countSentinelRows(manifest);
    if (total === 0) return { total, complete: false, exact: sentinelTotal === 0 };
    try {
      await store.verifyOwnership(manifest);
      if (!plan) return { total, complete: false, exact: false };
      await store.verifyExactRows(plan);
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
