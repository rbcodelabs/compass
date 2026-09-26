// Admin route: rebuild the in-app agent's golden Vercel Sandbox snapshot.
//
// The agent runtime boots each turn from a "golden" snapshot that already has
// the agent dependencies installed (see lib/agent-sandbox.ts and ADR 0001 §3).
// This endpoint (re)builds that snapshot and persists its id to the
// AgentRuntimeConfig singleton. Run it whenever SANDBOX_DEPENDENCIES change.
//
//   GET  → current status (stored snapshot id, fingerprint, staleness)
//   POST → build a fresh snapshot, persist it, delete the snapshot it
//          replaces, return id + timings + log
//
// Cleanup ordering (do not reorder): build → persist new snapshot as golden
// → ONLY THEN delete the previous one. Each golden snapshot is ~450MB; never
// deleting the previous one is exactly the leak that exhausted the team's
// Snapshot Storage quota and blocked all sandbox creation account-wide with a
// 402. Deleting first would risk leaving no working golden snapshot at all if
// anything failed mid-request, so the new snapshot must be confirmed
// persisted before its predecessor is removed. A failure to delete the old
// snapshot is logged as a warning in the response body, not a 500 — the
// rebuild itself already succeeded and the new snapshot is live.
//
// Auth: MIGRATION_SECRET via the `x-migration-secret` header — same trust
// boundary as /api/admin/migrate. No user session; server-to-server only.

import { NextRequest } from "next/server"
import { buildGoldenSnapshot, computeDepsFingerprint, deleteGoldenSnapshot } from "@/lib/agent-sandbox"
import { getAgentRuntimeConfig, setGoldenSnapshot } from "@/lib/agent-runtime-config"

export const runtime = "nodejs"
export const maxDuration = 300

function checkAuth(req: NextRequest): boolean {
  const secret = process.env.MIGRATION_SECRET
  // A missing/empty secret must never authorize — fail closed.
  if (!secret) return false
  return req.headers.get("x-migration-secret") === secret
}

export async function GET(req: NextRequest) {
  if (!checkAuth(req)) return new Response("Unauthorized", { status: 401 })

  const cfg = await getAgentRuntimeConfig()
  const currentDepsFingerprint = computeDepsFingerprint()
  return Response.json({
    goldenSnapshotId: cfg?.goldenSnapshotId ?? null,
    depsFingerprint: cfg?.depsFingerprint ?? null,
    snapshotBuiltAt: cfg?.snapshotBuiltAt ?? null,
    currentDepsFingerprint,
    stale: !cfg?.goldenSnapshotId || cfg.depsFingerprint !== currentDepsFingerprint,
  })
}

export async function POST(req: NextRequest) {
  if (!checkAuth(req)) return new Response("Unauthorized", { status: 401 })

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

    return Response.json({
      ok: true,
      ...result,
      log,
      previousSnapshotId,
      deletedPreviousSnapshot,
      ...(previousSnapshotDeleteError ? { previousSnapshotDeleteError } : {}),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return Response.json({ ok: false, error: message, log }, { status: 500 })
  }
}
