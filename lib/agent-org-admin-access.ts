import type getPrisma from "@/lib/db"
import { isOrgAdminRole } from "@/lib/roles"
import { agentOwner, listActiveAgentsOwnedBy } from "@/lib/agent-ownership"

export interface AgentAccessRow {
  agentId: string
  agentName: string
  ownerName: string
  granted: boolean
  grantedByName: string | null
  /** Granted, but the grantor is no longer an org OWNER/ADMIN — the grant confers nothing until re-issued. */
  inactive: boolean
}

/**
 * Rows for the org Settings "Agent access" section: ACTIVE agents that are
 * USER-owned by a current org member, joined with their live SCORING_MODEL_ADMIN grant.
 * WORKSPACE-owned agents are not listed: an org-admin grant confers nothing on them until the
 * run-as-agent change (PR2), so offering one would only mislead.
 * The grantor's CURRENT role is checked here for display, mirroring the
 * time-of-check rule in hasValidAgentOrgAdminGrant (ADR 0020, Risks).
 * The schema has no relations (DSQL), so joins are done in memory.
 */
export async function listAgentAccessRows(prisma: ReturnType<typeof getPrisma>, organizationId: string): Promise<AgentAccessRow[]> {
  const members = await prisma.organizationMember.findMany({
    where: { organizationId },
    select: { userId: true, role: true },
  })
  const roleByUser = new Map(members.map((m) => [m.userId, m.role]))
  const ownedAgents = await listActiveAgentsOwnedBy(prisma, { userIds: members.map((m) => m.userId), workspaceIds: [] })
  const agents = ownedAgents.filter((a) => agentOwner(a)?.type === "USER")
  if (agents.length === 0) return []
  const grants = await prisma.agentOrgAdminGrant.findMany({
    where: { organizationId, capability: "SCORING_MODEL_ADMIN", revokedAt: null, agentId: { in: agents.map((a) => a.id) } },
    select: { agentId: true, grantedByUserId: true },
  })
  const grantByAgent = new Map(grants.map((g) => [g.agentId, g]))
  const userIds = [...new Set([...agents.flatMap((a) => { const owner = agentOwner(a); return owner?.type === "USER" ? [owner.userId] : [] }), ...grants.map((g) => g.grantedByUserId)])]
  const users = await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, email: true } })
  const label = new Map(users.map((u) => [u.id, u.name || u.email]))

  const ownerLabel = (a: (typeof agents)[number]) => {
    const owner = agentOwner(a)
    return (owner?.type === "USER" && label.get(owner.userId)) || "Unknown user"
  }

  return agents.map((a) => {
    const grant = grantByAgent.get(a.id)
    return {
      agentId: a.id,
      agentName: a.name,
      ownerName: ownerLabel(a),
      granted: !!grant,
      grantedByName: grant ? (label.get(grant.grantedByUserId) ?? "Unknown user") : null,
      inactive: !!grant && !isOrgAdminRole(roleByUser.get(grant.grantedByUserId)),
    }
  })
}
