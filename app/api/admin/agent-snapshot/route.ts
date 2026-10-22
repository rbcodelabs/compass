// Platform-admin route: view and rebuild the in-app agent's golden Vercel
// Sandbox snapshot from the settings UI (/settings/admin/agent-snapshot).
//
//   GET  → current status (same shape as the secret route)
//   POST → rebuild; same build → persist → delete-previous behaviour
//
// Auth: signed-in session whose email is in PLATFORM_ADMIN_EMAILS
// (lib/platform-admin.ts). 401 = no session, 403 = signed in but not a
// platform admin (including when the allowlist is unset). The
// MIGRATION_SECRET twin at /api/admin/rebuild-agent-snapshot stays for
// server-to-server use; that secret never goes to the browser.
//
// DURATION — the build takes minutes; see the note in the secret route.

import { auth } from "@/auth"
import { getAgentSnapshotStatus, rebuildAgentSnapshot } from "@/lib/agent-snapshot-admin"
import { isPlatformAdminSession } from "@/lib/platform-admin"

export const runtime = "nodejs"
export const maxDuration = 300

async function authorize(): Promise<Response | null> {
  const session = await auth()
  if (!session?.user?.id) return new Response("Unauthorized", { status: 401 })
  if (!isPlatformAdminSession(session)) return new Response("Forbidden", { status: 403 })
  return null
}

export async function GET() {
  const denied = await authorize()
  if (denied) return denied
  return Response.json(await getAgentSnapshotStatus())
}

export async function POST() {
  const denied = await authorize()
  if (denied) return denied
  const result = await rebuildAgentSnapshot()
  return Response.json(result, { status: result.ok ? 200 : 500 })
}
