/**
 * Accessor for AgentRuntimeSnapshot (migration 110): one row per sandbox class holding that class's
 * current Vercel Sandbox snapshot. Only the DEVELOPER class lives here today; the STANDARD snapshot is
 * still AgentRuntimeConfig.goldenSnapshotId (lib/agent-runtime-config.ts) until a later migration moves it.
 *
 * `baseSnapshotId` is the STANDARD snapshot a DEVELOPER snapshot was layered on. A derived snapshot
 * survives deletion of its base (verified by spike), so it is a staleness signal, not a dependency.
 */

import getPrisma from "@/lib/db"

export type SandboxClass = "STANDARD" | "DEVELOPER"

export type AgentRuntimeSnapshot = {
  snapshotId: string | null
  depsFingerprint: string | null
  baseSnapshotId: string | null
  snapshotBuiltAt: Date | null
}

export async function getRuntimeSnapshot(sandboxClass: SandboxClass): Promise<AgentRuntimeSnapshot | null> {
  const row = await getPrisma().agentRuntimeSnapshot.findUnique({
    where: { sandboxClass },
    select: { snapshotId: true, depsFingerprint: true, baseSnapshotId: true, snapshotBuiltAt: true },
  })
  return row ?? null
}

/** Upsert a class's snapshot pointer, setting updatedAt explicitly (DSQL has no @updatedAt trigger). */
export async function setRuntimeSnapshot(
  sandboxClass: SandboxClass,
  params: { snapshotId: string; depsFingerprint: string; baseSnapshotId: string | null; snapshotBuiltAt: Date },
): Promise<void> {
  const now = new Date()
  await getPrisma().agentRuntimeSnapshot.upsert({
    where: { sandboxClass },
    create: { sandboxClass, ...params, updatedAt: now },
    update: { ...params, updatedAt: now },
  })
}
