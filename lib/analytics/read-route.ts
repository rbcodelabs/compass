import { NextResponse } from "next/server"
import { auth } from "@/auth"
import { getWorkspace } from "@/lib/workspace"
import type { McpActor } from "@/lib/mcp-authz"

/**
 * Shared session + membership gate for the analytics read routes. Reads go
 * through route handlers, not server actions: an in-flight server action
 * commits the router state it started from, so a panel read that resolves
 * after the user closes the panel restores `?detail=` and reopens it.
 */
export async function analyticsReadContext(request: Request): Promise<
  | { ok: true; actor: McpActor; workspaceId: string; searchParams: URLSearchParams }
  | { ok: false; response: NextResponse }
> {
  const session = await auth()
  if (!session?.user?.id) return { ok: false, response: json({ error: "Unauthorized" }, 401) }
  const { searchParams } = new URL(request.url)
  const orgSlug = searchParams.get("orgSlug")
  const workspaceSlug = searchParams.get("workspaceSlug")
  if (!orgSlug || !workspaceSlug) return { ok: false, response: json({ error: "Missing orgSlug or workspaceSlug" }, 400) }
  const workspace = await getWorkspace(orgSlug, workspaceSlug, session.user.id)
  if (!workspace) return { ok: false, response: json({ error: "Not found" }, 404) }
  return { ok: true, actor: { userId: session.user.id, purpose: "USER" }, workspaceId: workspace.id, searchParams }
}

export function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } })
}
