import { NextResponse } from "next/server"
import { auth } from "@/auth"
import getPrisma from "@/lib/db"
import { getWorkspace } from "@/lib/workspace"
import { resolveThinkingModel } from "@/lib/thinking-model/resolve"
import { chainGraphEnabled } from "@/lib/chain-graph/flag"
import { clampDepth, parseFocusRef, resolveFocusKey } from "@/lib/chain-graph/focus"
import { loadChainGraphForRequest } from "@/lib/chain-graph/loader"

/**
 * Chain graph data. GET /api/chain-graph?orgSlug&workspaceSlug&scope=workspace|focus[&focus=<TYPE>:<id>|<DISPLAY-ID>&depth=<n>]
 * returns `{ nodes, edges, truncated }` (lib/chain-graph/types.ts).
 *
 * Same two-layer auth as /api/panels/entity: a session, then workspace membership resolved by getWorkspace (a non-member
 * and a missing workspace are the same 404). The workspace id never comes from the client. Size is bounded by the
 * loader's caps (1,500 nodes) and the focus depth clamp (default 6, max 12); truncation is reported in the body.
 * `focus` must resolve inside the workspace (UUID or display ID); anything else is the same 404 as a missing id.
 */
export async function GET(req: Request) {
  if (!chainGraphEnabled()) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const orgSlug = searchParams.get("orgSlug")
  const workspaceSlug = searchParams.get("workspaceSlug")
  if (!orgSlug || !workspaceSlug) return NextResponse.json({ error: "orgSlug and workspaceSlug are required" }, { status: 400 })

  const scope = searchParams.get("scope") ?? "workspace"
  if (scope !== "workspace" && scope !== "focus") return NextResponse.json({ error: "scope must be workspace or focus" }, { status: 400 })

  const workspace = await getWorkspace(orgSlug, workspaceSlug, session.user.id)
  if (!workspace) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const prisma = getPrisma()
  let focusKey: string | null = null
  if (scope === "focus") {
    const focus = parseFocusRef(searchParams.get("focus") ?? undefined)
    if (!focus) return NextResponse.json({ error: "focus must be <TYPE>:<id> or a display ID like OPP-12" }, { status: 400 })
    focusKey = await resolveFocusKey(prisma, workspace.id, focus)
    if (!focusKey) return NextResponse.json({ error: "Not found" }, { status: 404 })
  }

  const { links } = resolveThinkingModel(workspace)
  const graph = await loadChainGraphForRequest(prisma, workspace.id, { links, focusKey, depth: clampDepth(searchParams.get("depth")) })
  return NextResponse.json(graph, { headers: { "cache-control": "private, no-store" } })
}
