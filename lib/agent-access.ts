import getPrisma from "@/lib/db"
import type { Prisma } from "@prisma/client"
import type { McpActor } from "@/lib/mcp-authz"

export const agentsEnabled = () => process.env.COMPASS_AGENTS_ENABLED === "1"

export async function agentWorkspaceWhere(actor: McpActor): Promise<Prisma.WorkspaceWhereInput> {
  if (actor.purpose === "SERVICE") return {}
  if (!actor.userId) return { id: { in: [] } }
  const membership = { members: { some: { userId: actor.userId } } }
  if (actor.purpose !== "AGENT") return { ...membership, ...(actor.scopeWorkspaceId ? { id: actor.scopeWorkspaceId } : {}) }
  if (!agentsEnabled() || !actor.agentId || !actor.userId) return { id: { in: [] } }
  const prisma = getPrisma()
  const agent = await prisma.agent.findFirst({ where: { id: actor.agentId, ownerUserId: actor.userId, status: "ACTIVE" }, select: { id: true } })
  if (!agent) return { id: { in: [] } }
  const grants = await prisma.agentWorkspaceGrant.findMany({ where: { agentId: actor.agentId, revokedAt: null, ...(actor.requiredAgentAccess === "WRITE" ? { access: "WRITE" } : { access: { in: ["READ", "WRITE"] } }) }, select: { workspaceId: true } })
  return { ...membership, id: { in: grants.map(g => g.workspaceId).filter(id => !actor.scopeWorkspaceId || id === actor.scopeWorkspaceId) } }
}

export async function assertAgentWorkspaceAccess(actor: McpActor, workspaceId: string, access: "READ" | "WRITE" = "READ") {
  const found = await getPrisma().workspace.findFirst({ where: { AND: [{ id: workspaceId }, await agentWorkspaceWhere({ ...actor, requiredAgentAccess: access })] }, select: { id: true } })
  if (!found) throw new Error("Workspace not found or access denied.")
}
