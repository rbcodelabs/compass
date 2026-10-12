/**
 * The Docs "Library" tree for the agent rail's Library view.
 *
 * The Docs route layout fetches this server-side and passes it down as props.
 * The rail cannot: it lives in the workspace layout, outside the docs route, and
 * is never re-rendered by navigation (that is the point of it), so it has to
 * fetch. Same query and same `buildDocTree` as the layout.
 *
 * Membership is checked here, not assumed: `workspaceId` would otherwise be an
 * unvalidated client value. `getWorkspace` returns null for a non-member.
 */

import { auth } from "@/auth"
import getPrisma from "@/lib/db"
import { getWorkspace } from "@/lib/workspace"
import { buildDocTree } from "@/lib/doc-tree"

const NO_STORE_HEADERS = { "Cache-Control": "private, no-store" }

export async function GET(request: Request) {
  const session = await auth()
  if (!session?.user?.id) {
    return Response.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE_HEADERS })
  }

  const { searchParams } = new URL(request.url)
  const orgSlug = searchParams.get("orgSlug")
  const workspaceSlug = searchParams.get("workspaceSlug")
  if (!orgSlug || !workspaceSlug) {
    return Response.json({ error: "Workspace required" }, { status: 400, headers: NO_STORE_HEADERS })
  }

  const workspace = await getWorkspace(orgSlug, workspaceSlug, session.user.id)
  if (!workspace) {
    return Response.json({ error: "Workspace not found" }, { status: 404, headers: NO_STORE_HEADERS })
  }

  const prisma = getPrisma()
  const [rawDocs, artifacts] = await Promise.all([
    prisma.doc.findMany({
      where: { workspaceId: workspace.id },
      select: { id: true, title: true, icon: true, parentId: true, sortOrder: true, docType: true },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    }),
    prisma.artifact.findMany({
      where: { workspaceId: workspace.id, status: "ACTIVE" },
      select: { id: true, title: true, sourceType: true },
      orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
    }),
  ])

  return Response.json(
    { workspaceId: workspace.id, docs: buildDocTree(rawDocs), artifacts },
    { headers: NO_STORE_HEADERS },
  )
}
