/**
 * Reusable Vercel Sandbox mechanics for the in-app agent runtime.
 *
 * Productionizes the throwaway spike (branch feat/agent-sdk-sandbox-spike):
 *  - `buildGoldenSnapshot()` — create a sandbox, `npm install` the agent deps,
 *    and `session.snapshot()` it, so agent turns can boot warm (~200ms) instead
 *    of paying the ~10s cold install every turn.
 *  - `bootSandboxFromSnapshot()` — the warm boot path used by the turn service.
 *  - `deleteGoldenSnapshot()` — delete a golden snapshot from Vercel Sandbox
 *    storage. Every rebuild leaves the *previous* golden snapshot orphaned
 *    unless the caller explicitly deletes it (see
 *    POST /api/admin/rebuild-agent-snapshot, which does this after the new
 *    snapshot is confirmed persisted) — each one is ~450MB, and left
 *    unattended these silently accumulate until the team's Snapshot Storage
 *    quota is exceeded and Vercel starts rejecting ALL sandbox creation
 *    account-wide with a 402.
 *
 * DESIGN NOTE — only DEPENDENCIES are baked into the snapshot, not the agent
 * entry script. The entry script is written per-turn (cheap) in Phase 3, so
 * iterating on agent logic does NOT require a snapshot rebuild — only changing
 * SANDBOX_DEPENDENCIES does. `computeDepsFingerprint()` captures exactly that
 * surface, and AgentRuntimeConfig.depsFingerprint records which deps a snapshot
 * was built from (drift detection). See docs/decisions/0001-…§3.
 *
 * Secrets are NEVER written during the build — they are passed at runCommand
 * time on the warm path only, so no secret enters a snapshot's filesystem.
 */

import { createHash } from "node:crypto"
import { Sandbox, Snapshot } from "@vercel/sandbox"

export const SANDBOX_RUNTIME = "node24"
const SANDBOX_TIMEOUT_MS = 5 * 60_000

/**
 * Single source of truth for the sandbox's dependency set. Changing this is
 * what necessitates a golden-snapshot rebuild (via
 * POST /api/admin/rebuild-agent-snapshot).
 */
export const SANDBOX_DEPENDENCIES: Record<string, string> = {
  "@anthropic-ai/claude-agent-sdk": "0.3.224",
  "@modelcontextprotocol/sdk": "^1.29.0",
  // ADR 0019 (Docs as a Virtual Filesystem): turn-entry.ts's `docsfs` in-process
  // MCP server wraps @rbcodelabs/geode-headless's /wiki subpath
  // (openWikiSession) for the sandbox-local delete/move/final-state-read
  // mechanics. Pinned to the exact version Compass already depends on
  // host-side (package.json) so both sides of the pilot stay in lockstep.
  "@rbcodelabs/geode-headless": "0.1.0",
  zod: "^4.0.0",
}

/** The canonical package.json installed inside the sandbox (deps only). */
export function sandboxPackageJson(): string {
  return JSON.stringify(
    { name: "agent-sandbox", private: true, type: "module", dependencies: SANDBOX_DEPENDENCIES },
    null,
    2
  )
}

/**
 * SHA-256 of the canonical sandbox package.json. Records which dependency set a
 * golden snapshot was built from; a mismatch means the snapshot is stale.
 */
export function computeDepsFingerprint(): string {
  return createHash("sha256").update(sandboxPackageJson()).digest("hex")
}

export type BuildSnapshotResult = {
  snapshotId: string
  depsFingerprint: string
  sizeBytes: number
  timings: { createMs: number; installMs: number; snapshotMs: number; totalMs: number }
}

/**
 * Build a golden snapshot: fresh sandbox → write package.json → `npm install`
 * → `session.snapshot()`. Note `snapshot()` stops the session, so no agent is
 * run and no secret is present. Returns the new snapshot id + the deps
 * fingerprint it was built from.
 */
export async function buildGoldenSnapshot(opts?: {
  onProgress?: (line: string) => void
}): Promise<BuildSnapshotResult> {
  const emit = opts?.onProgress ?? (() => {})
  const startedAt = Date.now()
  let sandbox: Sandbox | undefined
  let snapshotted = false
  try {
    const createStart = Date.now()
    sandbox = await Sandbox.create({ runtime: SANDBOX_RUNTIME, timeout: SANDBOX_TIMEOUT_MS })
    const createMs = Date.now() - createStart
    emit(`sandbox created: ${sandbox.name} (${createMs}ms)`)

    await sandbox.writeFiles([{ path: "package.json", content: sandboxPackageJson() }])
    emit("wrote package.json; running npm install...")

    const installStart = Date.now()
    const install = await sandbox.runCommand({
      cmd: "npm",
      args: ["install", "--no-audit", "--no-fund"],
      detached: true,
    })
    for await (const log of install.logs()) emit(`[npm:${log.stream}] ${log.data.trimEnd()}`)
    const installResult = await install.wait()
    const installMs = Date.now() - installStart
    if (installResult.exitCode !== 0) {
      throw new Error(`npm install failed with exit code ${installResult.exitCode}`)
    }
    emit(`npm install finished (${installMs}ms)`)

    const snapStart = Date.now()
    const snap = await sandbox.currentSession().snapshot()
    const snapshotMs = Date.now() - snapStart
    snapshotted = true // snapshot() stops the session; do not stop() again
    emit(`snapshot created: ${snap.snapshotId} (${snapshotMs}ms, ${snap.sizeBytes} bytes)`)

    return {
      snapshotId: snap.snapshotId,
      depsFingerprint: computeDepsFingerprint(),
      sizeBytes: snap.sizeBytes,
      timings: { createMs, installMs, snapshotMs, totalMs: Date.now() - startedAt },
    }
  } finally {
    if (sandbox && !snapshotted) {
      try {
        await sandbox.stop()
      } catch {
        // best-effort cleanup
      }
    }
  }
}

/**
 * Boot a fresh sandbox FROM a golden snapshot (warm path). Dependencies are
 * already installed; the caller writes the per-turn entry script and runs it.
 */
export async function bootSandboxFromSnapshot(snapshotId: string): Promise<Sandbox> {
  return Sandbox.create({ source: { type: "snapshot", snapshotId }, timeout: SANDBOX_TIMEOUT_MS })
}

/**
 * Delete a golden snapshot from Vercel Sandbox storage.
 *
 * Callers MUST only invoke this for a snapshot that is no longer referenced
 * by AgentRuntimeConfig.goldenSnapshotId — deleting the *current* golden
 * snapshot would leave the agent runtime with nothing to boot from. The
 * rebuild route enforces this by persisting the new snapshot id first and
 * only deleting the previous one afterward.
 *
 * Uses the same OIDC/token credential resolution as `Sandbox.create()`
 * (no explicit team/project/token wiring needed here or in production).
 * Throws on failure — callers that consider deletion best-effort (the
 * rebuild route does) should catch and log rather than fail the request.
 */
export async function deleteGoldenSnapshot(snapshotId: string): Promise<void> {
  const snapshot = await Snapshot.get({ snapshotId })
  await snapshot.delete()
}
