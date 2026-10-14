import { NextResponse } from "next/server"
import getPrisma from "@/lib/db"
import { followingAvailable } from "@/lib/following-flag"
import { isFollowingCaller, resolveFollowingCaller } from "@/lib/following-http"
import { unreadCount } from "@/lib/notifications"

/**
 * The bell's small refetch: GET /api/notifications/unread?orgSlug&workspaceSlug
 * -> { available, count, overflow }. The count is capped at 99 by the service so
 * the query never scans an unbounded backlog; `overflow` renders as "99+".
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const caller = await resolveFollowingCaller(searchParams.get("orgSlug"), searchParams.get("workspaceSlug"))
  if (!isFollowingCaller(caller)) return caller
  const prisma = getPrisma()
  if (!(await followingAvailable(prisma))) return NextResponse.json({ available: false, count: 0, overflow: false })
  const { count, overflow } = await unreadCount(caller.userId, caller.workspaceId, prisma)
  return NextResponse.json({ available: true, count, overflow })
}
