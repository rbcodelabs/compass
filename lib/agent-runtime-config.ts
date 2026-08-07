/**
 * Accessor for the deployment-global agent runtime config singleton
 * (AgentRuntimeConfig, one row, scope = "global").
 *
 * Holds the current "golden" Vercel Sandbox snapshot the in-app agent boots
 * from. Written by POST /api/admin/rebuild-agent-snapshot; read by the agent
 * turn service (Phase 3). See docs/decisions/0001-in-app-agent-architecture.md §3.
 */

import getPrisma from "@/lib/db"

const SCOPE = "global"

export type AgentRuntimeConfig = {
  goldenSnapshotId: string | null
  depsFingerprint: string | null
  snapshotBuiltAt: Date | null
}

/** Read the singleton config, or null if it has never been initialized. */
export async function getAgentRuntimeConfig(): Promise<AgentRuntimeConfig | null> {
  const prisma = getPrisma()
  const row = await prisma.agentRuntimeConfig.findUnique({
    where: { scope: SCOPE },
    select: { goldenSnapshotId: true, depsFingerprint: true, snapshotBuiltAt: true },
  })
  return row ?? null
}

/**
 * The current golden snapshot id, or null if no snapshot has been built yet
 * (callers fall back to a cold build in that case).
 */
export async function getGoldenSnapshotId(): Promise<string | null> {
  return (await getAgentRuntimeConfig())?.goldenSnapshotId ?? null
}

/**
 * True when the stored snapshot was built from a different sandbox dependency
 * set than `currentFingerprint` — i.e. the golden snapshot is stale and should
 * be rebuilt. Also true when nothing has been built yet.
 */
export async function isSnapshotStale(currentFingerprint: string): Promise<boolean> {
  const cfg = await getAgentRuntimeConfig()
  return !cfg?.goldenSnapshotId || cfg.depsFingerprint !== currentFingerprint
}

/**
 * Persist a freshly-built golden snapshot. Upserts the singleton and sets
 * updatedAt explicitly (DSQL has no @updatedAt trigger).
 */
export async function setGoldenSnapshot(params: {
  goldenSnapshotId: string
  depsFingerprint: string
  snapshotBuiltAt: Date
}): Promise<void> {
  const prisma = getPrisma()
  const now = new Date()
  await prisma.agentRuntimeConfig.upsert({
    where: { scope: SCOPE },
    create: { scope: SCOPE, ...params, updatedAt: now },
    update: { ...params, updatedAt: now },
  })
}
