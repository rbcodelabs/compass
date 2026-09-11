import { auth } from "@/auth"
import { getWorkspace } from "@/lib/workspace"
import { normalizeWorkspaceSearchQuery, searchWorkspace } from "@/lib/workspace-search"

const NO_STORE_HEADERS = { "Cache-Control": "private, no-store" }

export async function GET(request: Request) {
  const session = await auth()
  if (!session?.user?.id) {
    return Response.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE_HEADERS })
  }

  const { searchParams } = new URL(request.url)
  const orgSlug = searchParams.get("orgSlug")
  const workspaceSlug = searchParams.get("workspaceSlug")
  const normalized = normalizeWorkspaceSearchQuery(searchParams.get("q") ?? "")
  if (!orgSlug || !workspaceSlug || !normalized.ok) {
    return Response.json({ error: "Invalid search request" }, { status: 400, headers: NO_STORE_HEADERS })
  }

  const workspace = await getWorkspace(orgSlug, workspaceSlug, session.user.id)
  if (!workspace) {
    return Response.json({ error: "Workspace not found" }, { status: 404, headers: NO_STORE_HEADERS })
  }

  const result = await searchWorkspace({
    workspaceId: workspace.id,
    orgSlug,
    workspaceSlug,
    query: normalized.query,
  })
  return Response.json(result, { headers: NO_STORE_HEADERS })
}
