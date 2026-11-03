// Session-authed Google Drive search for the agent composer. The query runs against the signed-in
// user's own Drive connection (ADR-0018); only file IDs, titles and kinds come back, never file text.

import { NextRequest } from "next/server"
import { auth } from "@/auth"
import getPrisma from "@/lib/db"
import { DRIVE_SEARCH_MAX_CHARS, DRIVE_SEARCH_MIN_CHARS, searchUserDrive } from "@/lib/agent-drive-search"

export const runtime = "nodejs"
export const maxDuration = 30

const NO_STORE = { "Cache-Control": "private, no-store" }

export async function GET(request: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) return Response.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE })
  const userId = session.user.id

  const workspaceId = request.nextUrl.searchParams.get("workspaceId")
  const q = (request.nextUrl.searchParams.get("q") ?? "").trim()
  if (!workspaceId || q.length < DRIVE_SEARCH_MIN_CHARS || q.length > DRIVE_SEARCH_MAX_CHARS) {
    return Response.json({ error: "Invalid search request" }, { status: 400, headers: NO_STORE })
  }
  const workspace = await getPrisma().workspace.findFirst({ where: { id: workspaceId, members: { some: { userId } } }, select: { id: true } })
  if (!workspace) return Response.json({ error: "Workspace not found or access denied." }, { status: 404, headers: NO_STORE })

  return Response.json(await searchUserDrive(userId, q), { headers: NO_STORE })
}
