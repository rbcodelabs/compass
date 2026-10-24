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
import { buildDeveloperSnapshot, computeDeveloperFingerprint } from "@/lib/agent-sandbox-developer"
import { getRuntimeSnapshot, setRuntimeSnapshot } from "@/lib/agent-runtime-snapshots"

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

// ─── DEVELOPER class (layered on the golden snapshot) ────────────────────────────────────────────────

export type DeveloperSnapshotStatus = {
  snapshotId: string | null
  depsFingerprint: string | null
  baseSnapshotId: string | null
  snapshotBuiltAt: Date | null
  currentDepsFingerprint: string
  /** The STANDARD snapshot the next build would layer on; null when STANDARD has never been built. */
  currentBaseSnapshotId: string | null
  stale: boolean
}

/** Stale when never built, when the recipe changed, or when STANDARD has been rebuilt since (a new base id). */
export async function getDeveloperSnapshotStatus(): Promise<DeveloperSnapshotStatus> {
  const [row, base] = await Promise.all([getRuntimeSnapshot("DEVELOPER"), getAgentRuntimeConfig()])
  const currentDepsFingerprint = computeDeveloperFingerprint()
  const currentBaseSnapshotId = base?.goldenSnapshotId ?? null
  return {
    snapshotId: row?.snapshotId ?? null,
    depsFingerprint: row?.depsFingerprint ?? null,
    baseSnapshotId: row?.baseSnapshotId ?? null,
    snapshotBuiltAt: row?.snapshotBuiltAt ?? null,
    currentDepsFingerprint,
    currentBaseSnapshotId,
    stale: !row?.snapshotId || row.depsFingerprint !== currentDepsFingerprint || row.baseSnapshotId !== currentBaseSnapshotId,
  }
}

export type DeveloperSnapshotRebuildResult =
  | ({
      ok: true
      log: string[]
      previousSnapshotId: string | null
      deletedPreviousSnapshot: boolean
      previousSnapshotDeleteError?: string
    } & Awaited<ReturnType<typeof buildDeveloperSnapshot>>)
  | { ok: false; error: string; log: string[] }

/**
 * Build the DEVELOPER snapshot on the current golden snapshot, persist it, then delete the one it replaced
 * (same build → persist → delete ordering as above). Refuses when STANDARD has never been built: there is
 * nothing to layer on, and silently building a base here would hide that.
 */
export async function rebuildDeveloperSnapshot(): Promise<DeveloperSnapshotRebuildResult> {
  const log: string[] = []
  try {
    const baseSnapshotId = (await getAgentRuntimeConfig())?.goldenSnapshotId ?? null
    if (!baseSnapshotId) throw new Error("No STANDARD golden snapshot exists yet; rebuild it first, then rebuild the developer snapshot.")
    const previousSnapshotId = (await getRuntimeSnapshot("DEVELOPER"))?.snapshotId ?? null

    const result = await buildDeveloperSnapshot({ baseSnapshotId, onProgress: (line) => log.push(line) })
    await setRuntimeSnapshot("DEVELOPER", {
      snapshotId: result.snapshotId,
      depsFingerprint: result.depsFingerprint,
      baseSnapshotId: result.baseSnapshotId,
      snapshotBuiltAt: new Date(),
    })

    let deletedPreviousSnapshot = false
    let previousSnapshotDeleteError: string | null = null
    if (previousSnapshotId && previousSnapshotId !== result.snapshotId) {
      try {
        await deleteGoldenSnapshot(previousSnapshotId)
        deletedPreviousSnapshot = true
        log.push(`deleted previous developer snapshot: ${previousSnapshotId}`)
      } catch (err) {
        previousSnapshotDeleteError = err instanceof Error ? err.message : String(err)
        log.push(`WARNING: failed to delete previous developer snapshot ${previousSnapshotId}: ${previousSnapshotDeleteError}`)
      }
    }

    return { ok: true, ...result, log, previousSnapshotId, deletedPreviousSnapshot, ...(previousSnapshotDeleteError ? { previousSnapshotDeleteError } : {}) }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), log }
  }
}
