import getPrisma from "@/lib/db"
import type { Prisma } from "@prisma/client"
import type { McpActor } from "@/lib/mcp-authz"
import { isOrgAdminRole } from "@/lib/roles"

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

/**
 * Narrow, named admin capabilities an org OWNER/ADMIN can delegate to a
 * specific agent via AgentOrgAdminGrant (ADR 0020). Extend this union as new
 * capabilities are added — each one gates a specific set of MCP tools, never
 * a blanket "agent is an org admin" switch.
 */
export type AgentAdminCapability = "SCORING_MODEL_ADMIN"

/**
 * True when `actor` (an AGENT/AGENT_TURN identity) currently holds a live,
 * valid AgentOrgAdminGrant for `capability` in `organizationId`.
 *
 * "Live and valid" requires ALL of:
 *   - agents are enabled, and the actor carries both an agentId and userId;
 *   - that agent is ACTIVE and owned by actor.userId (mirrors every other
 *     agent-identity check in this file);
 *   - an unrevoked grant row exists for (agentId, organizationId, capability);
 *   - the human who ISSUED that grant (grantedByUserId) is a CURRENT org
 *     OWNER/ADMIN, re-checked live on every call — see the schema comment on
 *     AgentOrgAdminGrant for why this is time-of-check, not time-of-grant.
 *
 * On success, records the grant id on `actor.agentAdminGrantId` so the
 * caller (lib/agent-activity.ts) can attribute the resulting AgentToolCall
 * row to the exact grant that authorized it.
 */
export async function hasValidAgentOrgAdminGrant(
  actor: McpActor,
  organizationId: string,
  capability: AgentAdminCapability,
): Promise<boolean> {
  if (!agentsEnabled() || !actor.agentId || !actor.userId) return false
  const prisma = getPrisma()
  const agent = await prisma.agent.findFirst({ where: { id: actor.agentId, ownerUserId: actor.userId, status: "ACTIVE" }, select: { id: true } })
  if (!agent) return false
  const grant = await prisma.agentOrgAdminGrant.findFirst({
    where: { agentId: actor.agentId, organizationId, capability, revokedAt: null },
    select: { id: true, grantedByUserId: true },
  })
  if (!grant) return false
  const grantor = await prisma.organizationMember.findFirst({
    where: { organizationId, userId: grant.grantedByUserId },
    select: { role: true },
  })
  if (!isOrgAdminRole(grantor?.role)) return false
  actor.agentAdminGrantId = grant.id
  return true
}

/**
 * True when `actor` (an AGENT/AGENT_TURN identity) may exercise its OWNER's
 * org admin rights in `organizationId`: an agent acts with the delegated
 * authority of the human who owns it, so no per-agent AgentOrgAdminGrant is
 * needed for the tools that opt in (today only `create_workspace`).
 *
 * Requires ALL of:
 *   - agents are enabled, and the actor carries both an agentId and userId;
 *   - the actor is not bound to a single workspace (`scopeWorkspaceId`): a
 *     workspace-scoped identity must not be able to mint new workspaces;
 *   - the agent is ACTIVE and owned by actor.userId;
 *   - the owner is a CURRENT org OWNER/ADMIN, re-read from OrganizationMember
 *     on every call (time-of-check, same principle as
 *     hasValidAgentOrgAdminGrant) — demoting the owner revokes this at once.
 *
 * Audit attribution needs nothing extra: withAgentActivity already writes the
 * AgentToolCall row with agentId/userId, and `agentAdminGrantId` stays null
 * because no grant authorized the call.
 */
export async function hasOwnerOrgAdminRights(actor: McpActor, organizationId: string): Promise<boolean> {
  if (!agentsEnabled() || !actor.agentId || !actor.userId || actor.scopeWorkspaceId) return false
  const prisma = getPrisma()
  const agent = await prisma.agent.findFirst({ where: { id: actor.agentId, ownerUserId: actor.userId, status: "ACTIVE" }, select: { id: true } })
  if (!agent) return false
  const owner = await prisma.organizationMember.findFirst({
    where: { organizationId, userId: actor.userId },
    select: { role: true },
  })
  return isOrgAdminRole(owner?.role)
}
