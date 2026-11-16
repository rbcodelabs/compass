import { NextResponse } from "next/server"
import getPrisma from "@/lib/db"
import { followingAvailable } from "@/lib/following-flag"
import { isFollowingCaller, resolveFollowingCaller } from "@/lib/following-http"
import { listLiveAlertsSince, unreadCount } from "@/lib/notifications"

/**
 * The bell's small refetch: GET /api/notifications/unread?orgSlug&workspaceSlug[&since=ISO]
 * -> { available, count, overflow } (or with `since`, adds `{ serverNow, alerts }`).
 * The count is capped at 99 by the service so the query never scans an unbounded
 * backlog; `overflow` renders as "99+".
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const caller = await resolveFollowingCaller(searchParams.get("orgSlug"), searchParams.get("workspaceSlug"))
  if (!isFollowingCaller(caller)) return caller

  const sinceParam = searchParams.get("since")
  const prisma = getPrisma()

  if (sinceParam === null) {
    if (!(await followingAvailable(prisma, caller.workspaceId))) return NextResponse.json({ available: false, count: 0, overflow: false })
    const { count, overflow } = await unreadCount(caller.userId, caller.workspaceId, prisma)
    return NextResponse.json({ available: true, count, overflow })
  }

  const sinceDate = sinceParam.trim() === "" ? new Date(Number.NaN) : new Date(sinceParam)
  if (Number.isNaN(sinceDate.getTime())) {
    return NextResponse.json({ error: "Invalid since timestamp" }, { status: 400 })
  }

  const serverNow = new Date().toISOString()
  if (!(await followingAvailable(prisma, caller.workspaceId))) {
    return NextResponse.json({ available: false, count: 0, overflow: false, serverNow, alerts: [] })
  }

  const [{ count, overflow }, alerts] = await Promise.all([
    unreadCount(caller.userId, caller.workspaceId, prisma),
    listLiveAlertsSince(caller.userId, caller.workspaceId, sinceDate, { prisma }),
  ])
  return NextResponse.json({ available: true, count, overflow, serverNow, alerts })
}
