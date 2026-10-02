import { NextResponse } from "next/server"
import { auth } from "@/auth"
import { getWorkspace } from "@/lib/workspace"

/**
 * Shared auth for the small following and notifications routes. Same two layers
 * as app/api/panels/entity: a signed-in user, then membership of the org and
 * workspace named in the request. Everything these routes read or write is the
 * caller's own, keyed by the session user and never by a client-supplied id.
 */
export type FollowingCaller = { userId: string; workspaceId: string }

export async function resolveFollowingCaller(orgSlug: string | null | undefined, workspaceSlug: string | null | undefined): Promise<FollowingCaller | NextResponse> {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!orgSlug || !workspaceSlug) return NextResponse.json({ error: "orgSlug and workspaceSlug are required" }, { status: 400 })
  // Null for a missing workspace and for a non-member alike, so existence never leaks.
  const workspace = await getWorkspace(orgSlug, workspaceSlug, session.user.id)
  if (!workspace) return NextResponse.json({ error: "Not found" }, { status: 404 })
  return { userId: session.user.id, workspaceId: workspace.id }
}

export const isFollowingCaller = (value: FollowingCaller | NextResponse): value is FollowingCaller => !(value instanceof NextResponse)

export async function readJsonObject(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await req.json()
    return body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null
  } catch {
    return null
  }
}
