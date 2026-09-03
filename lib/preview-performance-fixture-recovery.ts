import type { Prisma, PrismaClient } from "@prisma/client";
import getPrisma from "@/lib/db";
import {
  CLEANUP_ORDER,
  FIXTURE_COUNTS,
  buildDeterministicPreviewFixturePlan,
  createPreviewFixtureManifest,
  type PreviewFixtureKind,
  type PreviewFixtureManifest,
  type PreviewFixturePlan,
} from "@/lib/preview-performance-fixture";
import { PrismaPreviewFixtureStore } from "@/lib/preview-performance-fixture-prisma";

export const RECOVERY_CHUNK_SIZE = 100;

export const SOURCE_FIXTURE_IDENTITY = Object.freeze({
  runId: "perf_preview_bddc18c1097e28db66f7d8f8350948e1",
  deploymentSha: "d3122ed2b44d68dc28eac7afb55d4f0f341a7ab0",
  deploymentId: "dpl_AbsPX5FEaKoAk4odLWNucK4pesqW",
  deploymentUrl: "https://compass-f19iam4a7-rbcodelabs-team.vercel.app/",
});

export interface RecoveryFixtureInspection {
  counts: Record<PreviewFixtureKind, number>;
  total: number;
  sentinelTotal: number;
  exact: boolean;
}

export interface RecoveryFixtureStore {
  inspect(manifest: PreviewFixtureManifest, plan: PreviewFixturePlan): Promise<RecoveryFixtureInspection>;
  deleteChunk(kind: PreviewFixtureKind, ids: readonly string[], manifest: PreviewFixtureManifest, plan: PreviewFixturePlan): Promise<number>;
}

function sourceState(): { manifest: PreviewFixtureManifest; plan: PreviewFixturePlan } {
  // Expiry and token are deliberately synthetic: cleanup never compares Auth.js
  // credentials. Every ID and every other field derives from the fixed source tuple.
  const plan = buildDeterministicPreviewFixturePlan({
    ...SOURCE_FIXTURE_IDENTITY,
    expiresAt: new Date("2026-09-02T23:59:59.000Z"),
    sessionToken: "recovery-placeholder-not-used-by-ownership-proof".padEnd(64, "x"),
  });
  return { plan, manifest: createPreviewFixtureManifest(plan) };
}

export function isValidMonotonicSubset(inspection: RecoveryFixtureInspection): boolean {
  if (!inspection.exact || inspection.total !== Object.values(inspection.counts).reduce((sum, count) => sum + count, 0)) return false;
  const expectedSentinels = inspection.counts.users + inspection.counts.organizations + inspection.counts.workspaces;
  if (inspection.sentinelTotal !== expectedSentinels) return false;
  for (const kind of CLEANUP_ORDER) {
    const count = inspection.counts[kind];
    const full = FIXTURE_COUNTS[kind];
    if (!Number.isInteger(count) || count < 0 || count > full) return false;
  }
  const firstExtant = CLEANUP_ORDER.findIndex((kind) => inspection.counts[kind] > 0);
  if (firstExtant < 0) return true;
  for (let index = 0; index < firstExtant; index++) if (inspection.counts[CLEANUP_ORDER[index]] !== 0) return false;
  for (let index = firstExtant + 1; index < CLEANUP_ORDER.length; index++) {
    if (inspection.counts[CLEANUP_ORDER[index]] !== FIXTURE_COUNTS[CLEANUP_ORDER[index]]) return false;
  }
  return true;
}

function requireSafeInspection(inspection: RecoveryFixtureInspection): void {
  if (!isValidMonotonicSubset(inspection)) throw new Error("Preview fixture recovery required");
}

export async function executePreviewFixtureRecoveryWithStore(
  action: "cleanup" | "verify",
  store: RecoveryFixtureStore,
): Promise<{ state: "absent"; residue: 0 }> {
  const { manifest, plan } = sourceState();
  let inspection = await store.inspect(manifest, plan);
  requireSafeInspection(inspection);
  if (action === "verify") {
    if (inspection.total !== 0 || inspection.sentinelTotal !== 0) throw new Error("Preview fixture recovery required");
    return { state: "absent", residue: 0 };
  }

  for (const kind of CLEANUP_ORDER) {
    const ids = manifest.plannedIds[kind];
    for (let offset = 0; offset < ids.length; offset += RECOVERY_CHUNK_SIZE) {
      const chunk = ids.slice(offset, offset + RECOVERY_CHUNK_SIZE);
      try {
        await store.deleteChunk(kind, chunk, manifest, plan);
      } catch {
        throw new Error("Preview fixture recovery required", { cause: undefined });
      }
    }
  }
  inspection = await store.inspect(manifest, plan);
  requireSafeInspection(inspection);
  if (inspection.total !== 0 || inspection.sentinelTotal !== 0) throw new Error("Preview fixture recovery required");
  return { state: "absent", residue: 0 };
}

export class PrismaRecoveryFixtureStore implements RecoveryFixtureStore {
  constructor(private readonly prisma: PrismaClient) {}

  async inspect(manifest: PreviewFixtureManifest, plan: PreviewFixturePlan): Promise<RecoveryFixtureInspection> {
    const store = new PrismaPreviewFixtureStore(this.prisma);
    const counts = await store.countPlannedRowsByKind(manifest);
    const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
    const sentinelTotal = await store.countSentinelRows(manifest);
    try {
      await store.verifyOwnership(manifest);
      await store.verifyExactRows(plan);
      return { counts, total, sentinelTotal, exact: true };
    } catch {
      return { counts, total, sentinelTotal, exact: false };
    }
  }

  async deleteChunk(kind: PreviewFixtureKind, ids: readonly string[], manifest: PreviewFixtureManifest, plan: PreviewFixturePlan): Promise<number> {
    if (ids.length === 0 || ids.length > RECOVERY_CHUNK_SIZE) throw new Error("Invalid recovery chunk");
    const existing = await new PrismaPreviewFixtureStore(this.prisma).countIds(kind, ids);
    if (existing === 0) return 0;
    return this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const store = new PrismaPreviewFixtureStore(tx);
      const chunkIds = new Set(ids);
      const expectedRows = plan.rows[kind].filter(({ id }) => chunkIds.has(id));
      if (expectedRows.length !== ids.length) throw new Error("Invalid recovery chunk identity");
      await store.verifyExactRowsForIds(kind, expectedRows);
      const before = await store.countIds(kind, ids);
      const affected = await store.deleteIdsDirectWithCount(kind, ids);
      if (affected !== before) throw new Error("Preview fixture changed during recovery chunk");
      return affected;
    }, { maxWait: 10_000, timeout: 30_000 });
  }
}

export async function executePreviewFixtureRecovery(action: "cleanup" | "verify") {
  return executePreviewFixtureRecoveryWithStore(action, new PrismaRecoveryFixtureStore(getPrisma()));
}
