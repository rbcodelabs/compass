import getPrisma from "@/lib/db"
import type { Prisma } from "@prisma/client"
import type { McpActor } from "@/lib/mcp-authz"
import { isOrgAdminRole } from "@/lib/roles"
import { agentIdentityValidForTurn, agentIdentityValidForUser, agentOwner, findAgentById, isUserOwnedBy, isWorkspaceAdminUser, type AgentRecord } from "@/lib/agent-ownership"

export const agentsEnabled = () => process.env.COMPASS_AGENTS_ENABLED === "1"

/**
 * True for an actor that acts through an `agents` row: a personal AGENT key or OAuth binding, or an
 * AGENT_TURN credential minted for a cloud run of a specific agent. A legacy AGENT_TURN credential with
 * no agentId is the built-in assistant acting as the user, and is NOT an agent actor here.
 */
export function isAgentIdentityActor(actor: McpActor): boolean {
  return actor.purpose === "AGENT" || (actor.purpose === "AGENT_TURN" && !!actor.agentId)
}

/** Whether `agent` is a valid identity for this already-authenticated actor (see agentIdentityValidForTurn). */
export function agentIdentityValidForActor(agent: AgentRecord, actor: McpActor): boolean {
  if (actor.purpose === "AGENT_TURN") {
    return agentIdentityValidForTurn(agent, { agentId: actor.agentId, invokerUserId: actor.userId, runId: actor.agentRunId })
  }
  return agentIdentityValidForUser(agent, actor.userId)
}

/**
 * The workspaces where `agent` holds a live grant of at least `access`.
 *
 * A WORKSPACE-owned agent is confined to the workspace that owns it, and every one of its grants is
 * re-verified at the time of check: the human who issued it (grantedByUserId) must STILL administer the
 * owning workspace, so a grant cannot outlive the authority of the admin who gave it (ADR 0020's
 * time-of-check rule, applied to every shared-agent grant). A USER-owned agent keeps the existing
 * behavior; its owner's membership is intersected by the caller.
 */
export async function liveGrantedWorkspaceIds(agent: AgentRecord, access: "READ" | "WRITE" = "READ"): Promise<string[]> {
  const prisma = getPrisma()
  const grants = await prisma.agentWorkspaceGrant.findMany({
    where: { agentId: agent.id, revokedAt: null, ...(access === "WRITE" ? { access: "WRITE" } : { access: { in: ["READ", "WRITE"] } }) },
    select: { workspaceId: true, grantedByUserId: true },
  })
  const owner = agentOwner(agent)
  if (owner?.type !== "WORKSPACE") return owner?.type === "USER" ? grants.map((g) => g.workspaceId) : []
  const inOwningWorkspace = grants.filter((g) => g.workspaceId === owner.workspaceId)
  const stillAdmin = new Map<string, boolean>()
  for (const grant of inOwningWorkspace) {
    if (!stillAdmin.has(grant.grantedByUserId)) stillAdmin.set(grant.grantedByUserId, await isWorkspaceAdminUser(prisma, grant.grantedByUserId, owner.workspaceId))
  }
  return inOwningWorkspace.filter((g) => stillAdmin.get(g.grantedByUserId)).map((g) => g.workspaceId)
}

/**
 * For an AGENT_TURN actor acting as a WORKSPACE-owned agent: the organization that agent's owning workspace
 * belongs to. `undefined` = this is not such an actor (nothing to narrow); `null` = it is, but the agent or
 * its workspace is gone or invalid, so the caller must deny.
 */
export async function sharedAgentOrganizationId(actor: McpActor): Promise<string | null | undefined> {
  if (actor.purpose !== "AGENT_TURN" || !actor.agentId) return undefined
  if (!agentsEnabled()) return null
  const prisma = getPrisma()
  const agent = await findAgentById(prisma, actor.agentId)
  if (!agent || !agentIdentityValidForActor(agent, actor)) return null
  const owner = agentOwner(agent)
  if (owner?.type !== "WORKSPACE") return undefined
  const workspace = await prisma.workspace.findFirst({ where: { id: owner.workspaceId }, select: { organizationId: true } })
  return workspace?.organizationId ?? null
}

export async function agentWorkspaceWhere(actor: McpActor): Promise<Prisma.WorkspaceWhereInput> {
  if (actor.purpose === "SERVICE") return {}
  if (!actor.userId) return { id: { in: [] } }
  const membership = { members: { some: { userId: actor.userId } } }
  if (!isAgentIdentityActor(actor)) return { ...membership, ...(actor.scopeWorkspaceId ? { id: actor.scopeWorkspaceId } : {}) }
  if (!agentsEnabled() || !actor.agentId || !actor.userId) return { id: { in: [] } }
  const prisma = getPrisma()
  const agent = await findAgentById(prisma, actor.agentId)
  if (!agent || !agentIdentityValidForActor(agent, actor)) return { id: { in: [] } }
  const granted = (await liveGrantedWorkspaceIds(agent, actor.requiredAgentAccess === "WRITE" ? "WRITE" : "READ")).filter(id => !actor.scopeWorkspaceId || id === actor.scopeWorkspaceId)
  // A shared agent has no inherited authority, so the invoker's own membership is deliberately NOT part of
  // its reach: it sees exactly its live grants, however the invoker's access changes during the run.
  const sharedAgent = agentOwner(agent)?.type === "WORKSPACE"
  return { ...(sharedAgent ? {} : membership), id: { in: granted } }
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
 *   - that agent is ACTIVE and, when USER-owned, owned by actor.userId
 *     (WORKSPACE-owned agents have no owner to match; the grant is their only authority);
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
  const agent = await findAgentById(prisma, actor.agentId)
  if (!agent || !agentIdentityValidForActor(agent, actor)) return false
  // A WORKSPACE-owned agent passes the identity check above only as an AGENT_TURN credential tied to a live run of that exact
  // agent. Its grant must then be in the organization that owns the agent's workspace, never another organization.
  const owner = agentOwner(agent)
  if (owner?.type === "WORKSPACE") {
    const home = await prisma.workspace.findFirst({ where: { id: owner.workspaceId, organizationId }, select: { id: true } })
    if (!home) return false
  }
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
 *   - the agent is ACTIVE and USER-owned by actor.userId (a WORKSPACE-owned agent never inherits);
 *   - the owner is a CURRENT org OWNER/ADMIN, re-read from OrganizationMember
 *     on every call (time-of-check, same principle as
 *     hasValidAgentOrgAdminGrant) — demoting the owner revokes this at once.
 *
 * Audit attribution needs nothing extra: withAgentActivity already writes the
 * AgentToolCall row with agentId/userId, and `agentAdminGrantId` stays null
 * because no grant authorized the call.
 */
export async function hasOwnerOrgAdminRights(actor: McpActor, organizationId: string): Promise<boolean> {
  // A run's AGENT_TURN key is always workspace-scoped (mintAgentMcpKey), so it is refused here by scopeWorkspaceId; a shared
  // agent fails the USER-owned check below. Neither can inherit org-admin rights.
  if (!agentsEnabled() || !actor.agentId || !actor.userId || actor.scopeWorkspaceId) return false
  const prisma = getPrisma()
  const agent = await findAgentById(prisma, actor.agentId)
  // Only a USER-owned agent inherits its owner's rights; a WORKSPACE-owned one has none to inherit.
  if (!agent || agent.status !== "ACTIVE" || !isUserOwnedBy(agent, actor.userId)) return false
  const owner = await prisma.organizationMember.findFirst({
    where: { organizationId, userId: actor.userId },
    select: { role: true },
  })
  return isOrgAdminRole(owner?.role)
}
