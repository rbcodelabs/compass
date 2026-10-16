import type getPrisma from "@/lib/db"
import { isOrgAdminRole } from "@/lib/roles"

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
 * Rows for the org Settings "Agent access" section: ACTIVE agents whose owner
 * is a current org member, joined with their live SCORING_MODEL_ADMIN grant.
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
  const agents = await prisma.agent.findMany({
    where: { status: "ACTIVE", ownerUserId: { in: members.map((m) => m.userId) } },
    select: { id: true, name: true, ownerUserId: true },
    orderBy: { name: "asc" },
  })
  if (agents.length === 0) return []
  const grants = await prisma.agentOrgAdminGrant.findMany({
    where: { organizationId, capability: "SCORING_MODEL_ADMIN", revokedAt: null, agentId: { in: agents.map((a) => a.id) } },
    select: { agentId: true, grantedByUserId: true },
  })
  const grantByAgent = new Map(grants.map((g) => [g.agentId, g]))
  const userIds = [...new Set([...agents.map((a) => a.ownerUserId), ...grants.map((g) => g.grantedByUserId)])]
  const users = await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, email: true } })
  const label = new Map(users.map((u) => [u.id, u.name || u.email]))

  return agents.map((a) => {
    const grant = grantByAgent.get(a.id)
    return {
      agentId: a.id,
      agentName: a.name,
      ownerName: label.get(a.ownerUserId) ?? "Unknown user",
      granted: !!grant,
      grantedByName: grant ? (label.get(grant.grantedByUserId) ?? "Unknown user") : null,
      inactive: !!grant && !isOrgAdminRole(roleByUser.get(grant.grantedByUserId)),
    }
  })
}
