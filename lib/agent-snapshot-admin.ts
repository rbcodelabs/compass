/**
 * Shared status + rebuild logic for the in-app agent's golden Vercel Sandbox
 * snapshot. Used by the secret-gated route (/api/admin/rebuild-agent-snapshot)
 * and the session-gated platform-admin route (/api/admin/agent-snapshot); the
 * callers own auth, this module owns behaviour.
 *
 * Cleanup ordering (do not reorder): build → persist new snapshot as golden
 * → ONLY THEN delete the previous one. Each golden snapshot is ~450MB; never
 * deleting the previous one is exactly the leak that exhausted the team's
 * Snapshot Storage quota and blocked all sandbox creation account-wide with a
 * 402. Deleting first would risk leaving no working golden snapshot at all if
 * anything failed mid-request, so the new snapshot must be confirmed
 * persisted before its predecessor is removed. A failure to delete the old
 * snapshot is logged as a warning in the result, not an error — the rebuild
 * itself already succeeded and the new snapshot is live.
 */

import { buildGoldenSnapshot, computeDepsFingerprint, deleteGoldenSnapshot } from "@/lib/agent-sandbox"
import { getAgentRuntimeConfig, setGoldenSnapshot } from "@/lib/agent-runtime-config"

export type AgentSnapshotStatus = {
  goldenSnapshotId: string | null
  depsFingerprint: string | null
  snapshotBuiltAt: Date | null
  currentDepsFingerprint: string
  stale: boolean
}

export type AgentSnapshotRebuildResult =
  | ({
      ok: true
      log: string[]
      previousSnapshotId: string | null
      deletedPreviousSnapshot: boolean
      previousSnapshotDeleteError?: string
    } & Awaited<ReturnType<typeof buildGoldenSnapshot>>)
  | { ok: false; error: string; log: string[] }

export async function getAgentSnapshotStatus(): Promise<AgentSnapshotStatus> {
  const cfg = await getAgentRuntimeConfig()
  const currentDepsFingerprint = computeDepsFingerprint()
  return {
    goldenSnapshotId: cfg?.goldenSnapshotId ?? null,
    depsFingerprint: cfg?.depsFingerprint ?? null,
    snapshotBuiltAt: cfg?.snapshotBuiltAt ?? null,
    currentDepsFingerprint,
    stale: !cfg?.goldenSnapshotId || cfg.depsFingerprint !== currentDepsFingerprint,
  }
}

export async function rebuildAgentSnapshot(): Promise<AgentSnapshotRebuildResult> {
  const log: string[] = []
  try {
    // Capture the snapshot we're about to replace BEFORE overwriting it, so
    // we know what to clean up once the new one is confirmed persisted.
    const previousSnapshotId = (await getAgentRuntimeConfig())?.goldenSnapshotId ?? null

    const result = await buildGoldenSnapshot({ onProgress: (line) => log.push(line) })
    await setGoldenSnapshot({
      goldenSnapshotId: result.snapshotId,
      depsFingerprint: result.depsFingerprint,
      snapshotBuiltAt: new Date(),
    })

    // Only now — after the new snapshot is live as golden — clean up the one
    // it replaced. Skip when there's nothing to delete (first-ever build) or
    // the "previous" id is somehow the same as the new one. A delete failure
    // here is a non-fatal warning: the rebuild already succeeded.
    let deletedPreviousSnapshot = false
    let previousSnapshotDeleteError: string | null = null
    if (previousSnapshotId && previousSnapshotId !== result.snapshotId) {
      try {
        await deleteGoldenSnapshot(previousSnapshotId)
        deletedPreviousSnapshot = true
        log.push(`deleted previous golden snapshot: ${previousSnapshotId}`)
      } catch (err) {
        previousSnapshotDeleteError = err instanceof Error ? err.message : String(err)
        log.push(
          `WARNING: failed to delete previous golden snapshot ${previousSnapshotId}: ${previousSnapshotDeleteError}`
        )
      }
    }

    return {
      ok: true,
      ...result,
      log,
      previousSnapshotId,
      deletedPreviousSnapshot,
      ...(previousSnapshotDeleteError ? { previousSnapshotDeleteError } : {}),
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: message, log }
  }
}
