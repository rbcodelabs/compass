import { NextResponse } from "next/server"
import { isFollowingCaller, readJsonObject, resolveFollowingCaller } from "@/lib/following-http"
import { markAllRead, markRead } from "@/lib/notifications"

const MAX_IDS = 100

/**
 * POST /api/notifications/read  { orgSlug, workspaceSlug, ids?: string[], all?: true }
 * Marks the signed-in user's own notifications read: either the listed ids (up to
 * 100) or everything up to now. Rows belonging to anyone else are never touched,
 * whatever ids are sent. -> { marked }
 */
export async function POST(req: Request) {
  const body = await readJsonObject(req)
  if (!body) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  const caller = await resolveFollowingCaller(typeof body.orgSlug === "string" ? body.orgSlug : null, typeof body.workspaceSlug === "string" ? body.workspaceSlug : null)
  if (!isFollowingCaller(caller)) return caller

  const ids = body.ids
  const hasIds = Array.isArray(ids) && ids.length > 0 && ids.length <= MAX_IDS && ids.every((id) => typeof id === "string")
  const all = body.all === true
  if (hasIds === all) return NextResponse.json({ error: `Pass either ids (1 to ${MAX_IDS} strings) or all: true, not both` }, { status: 400 })

  const marked = all ? (await markAllRead(caller.userId, caller.workspaceId)).marked : await markRead(caller.userId, caller.workspaceId, ids as string[])
  return NextResponse.json({ marked })
}
