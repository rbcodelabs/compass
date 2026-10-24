// Admin route: rebuild the in-app agent's golden Vercel Sandbox snapshot.
//
// The agent runtime boots each turn from a "golden" snapshot that already has
// the agent dependencies installed (see lib/agent-sandbox.ts and ADR 0001 §3).
// This endpoint (re)builds that snapshot and persists its id to the
// AgentRuntimeConfig singleton. Run it whenever the snapshot recipe changes —
// dependencies, system packages, or runtime (see computeDepsFingerprint).
//
//   GET  → current status (stored snapshot id, fingerprint, staleness)
//   POST → build a fresh snapshot, persist it, delete the snapshot it
//          replaces, return id + timings + log
//
// Cleanup ordering (build → persist → ONLY THEN delete the previous snapshot)
// and its rationale live in lib/agent-snapshot-admin.ts. A failure to delete
// the old snapshot is a warning in the response body, not a 500.
//
// A session-authed twin for platform admins (the settings UI) lives at
// /api/admin/agent-snapshot; both share lib/agent-snapshot-admin.ts.
//
// Auth: MIGRATION_SECRET via the `x-migration-secret` header — same trust
// boundary as /api/admin/migrate. No user session; server-to-server only.
//
// DURATION — since the headless browser was added the build also installs Chromium's system libraries
// and downloads the browser, so it is minutes rather than seconds. `maxDuration`
// below is the ceiling: if a rebuild ever exceeds it, the POST returns a
// platform timeout while the sandbox keeps going, which can leave a built
// snapshot that was never persisted (harmless but wasted — just rerun). Check
// `timings.totalMs` in the response against this ceiling after any change that
// adds a build step.

import { NextRequest } from "next/server"
import { getAgentSnapshotStatus, getDeveloperSnapshotStatus, rebuildAgentSnapshot, rebuildDeveloperSnapshot } from "@/lib/agent-snapshot-admin"

export const runtime = "nodejs"
export const maxDuration = 300

function checkAuth(req: NextRequest): boolean {
  const secret = process.env.MIGRATION_SECRET
  // A missing/empty secret must never authorize — fail closed.
  if (!secret) return false
  return req.headers.get("x-migration-secret") === secret
}

// ?class=developer targets the layered developer snapshot; anything else (or nothing) is the STANDARD golden snapshot.
function isDeveloper(req: NextRequest): boolean {
  return new URL(req.url).searchParams.get("class") === "developer"
}

export async function GET(req: NextRequest) {
  if (!checkAuth(req)) return new Response("Unauthorized", { status: 401 })
  return Response.json(isDeveloper(req) ? await getDeveloperSnapshotStatus() : await getAgentSnapshotStatus())
}

export async function POST(req: NextRequest) {
  if (!checkAuth(req)) return new Response("Unauthorized", { status: 401 })
  const result = isDeveloper(req) ? await rebuildDeveloperSnapshot() : await rebuildAgentSnapshot()
  return Response.json(result, { status: result.ok ? 200 : 500 })
}
