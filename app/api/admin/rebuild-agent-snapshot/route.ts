// Admin route: rebuild the in-app agent's golden Vercel Sandbox snapshot.
//
// The agent runtime boots each turn from a "golden" snapshot that already has
// the agent dependencies installed (see lib/agent-sandbox.ts and ADR 0001 §3).
// This endpoint (re)builds that snapshot and persists its id to the
// AgentRuntimeConfig singleton. Run it whenever SANDBOX_DEPENDENCIES change.
//
//   GET  → current status (stored snapshot id, fingerprint, staleness)
//   POST → build a fresh snapshot, persist it, return id + timings + log
//
// Auth: MIGRATION_SECRET via the `x-migration-secret` header — same trust
// boundary as /api/admin/migrate. No user session; server-to-server only.

import { NextRequest } from "next/server"
import { buildGoldenSnapshot, computeDepsFingerprint } from "@/lib/agent-sandbox"
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
    const result = await buildGoldenSnapshot({ onProgress: (line) => log.push(line) })
    await setGoldenSnapshot({
      goldenSnapshotId: result.snapshotId,
      depsFingerprint: result.depsFingerprint,
      snapshotBuiltAt: new Date(),
    })
    return Response.json({ ok: true, ...result, log })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return Response.json({ ok: false, error: message, log }, { status: 500 })
  }
}
