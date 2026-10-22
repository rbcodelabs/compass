import { auth } from "@/auth"
import getPrisma from "@/lib/db"
import { listRunnableAgents } from "@/lib/agent-run-identity"

export const dynamic = "force-dynamic"

/**
 * The agents the signed-in member can pick in a workspace, and the one a run would use by default. Backs the chat's agent
 * selector and the Send to agent menu. Names the workspace by id (the chat) or by slugs (the menu); either way the caller
 * must be a member, and a non-member gets the same empty answer as a workspace with no agents.
 */
export async function GET(request: Request) {
  const session = await auth()
  if (!session?.user?.id) return new Response("Unauthorized", { status: 401 })
  const url = new URL(request.url)
  const workspaceId = url.searchParams.get("workspaceId")
  const orgSlug = url.searchParams.get("orgSlug")
  const workspaceSlug = url.searchParams.get("workspaceSlug")
  const prisma = getPrisma()
  const where = workspaceId
    ? { id: workspaceId, members: { some: { userId: session.user.id } } }
    : orgSlug && workspaceSlug
      ? { slug: workspaceSlug, organization: { slug: orgSlug }, members: { some: { userId: session.user.id } } }
      : null
  const workspace = where ? await prisma.workspace.findFirst({ where, select: { id: true } }) : null
  const empty = Response.json({ agents: [], defaultAgentId: null })
  if (!workspace) return empty
  const { agents, defaultAgentId } = await listRunnableAgents(prisma, { userId: session.user.id, workspaceId: workspace.id })
  return Response.json({ agents: agents.map((agent) => ({ id: agent.id, name: agent.name, shared: agent.ownerType === "WORKSPACE" })), defaultAgentId })
}
