import type { AppPrismaClient, AppTransactionClient } from "@/lib/db";
import { agentRunsAvailable } from "@/lib/agent-runs";
import { deleteWorkspaceAgentChildRuns } from "@/lib/agent-child-runs";
import { deleteWorkspaceAgentSessions } from "@/lib/agent-session";
import { deleteWorkspaceConversationReviews } from "@/lib/agent-board-data";

/**
 * Rejoining a workspace requires a fresh administrator grant. Only the removed member's USER-owned
 * agents lose their grants: a WORKSPACE-owned agent belongs to the workspace, not to a person, so
 * one member leaving must not strip it.
 */
export async function revokeMemberAgentGrants(prisma: AppTransactionClient, workspaceId: string, ownerUserId: string) {
  // Runs inside a transaction, where a failed statement aborts the whole transaction, so it selects only
  // `id` (a column that always exists) instead of using the column-fallback helpers. Only USER-owned
  // agents carry an ownerUserId; a WORKSPACE-owned row has none (see lib/agent-ownership.ts).
  const agents = await prisma.agent.findMany({ where: { ownerUserId }, select: { id: true } });
  if (agents.length) await prisma.agentWorkspaceGrant.updateMany({ where: { workspaceId, agentId: { in: agents.map((a) => a.id) }, revokedAt: null }, data: { revokedAt: new Date(), updatedAt: new Date() } });
}

/** This schema uses application-managed relations. Personal identities outlive workspaces. */
export async function deleteWorkspaceAgentData(prisma: AppPrismaClient, workspaceId: string) {
  await prisma.apiKey.deleteMany({ where: { scopeWorkspaceId: workspaceId, scopeConversationId: { not: null } } });
  await prisma.pMInterview.updateMany({ where: { workspaceId }, data: { agentConversationId: null } });
  // Runs and their events are keyed by conversation, so they have to go before
  // the conversations do. Guarded on availability: a deployment that has not yet
  // applied 069 must still be able to delete a workspace (same approach as the workspace-updates migration).
  await deleteWorkspaceAgentChildRuns(prisma, workspaceId);
  if (await agentRunsAvailable(prisma)) {
    const runs = await prisma.agentRun.findMany({ where: { workspaceId }, select: { id: true } });
    if (runs.length) await prisma.agentRunEvent.deleteMany({ where: { runId: { in: runs.map((run) => run.id) } } });
    await prisma.agentRun.deleteMany({ where: { workspaceId } });
  }
  await deleteWorkspaceAgentSessions(prisma, workspaceId);
  await prisma.agentMessage.deleteMany({ where: { conversation: { workspaceId } } });
  await prisma.agentAuditLog.deleteMany({ where: { workspaceId } });
  await deleteWorkspaceConversationReviews(prisma, workspaceId);
  await prisma.agentConversation.deleteMany({ where: { workspaceId } });
  await prisma.agentToolCall.deleteMany({ where: { workspaceId } });
  await prisma.agentWorkspaceGrant.deleteMany({ where: { workspaceId } });
  // Default-agent picks for this workspace, then the agents the workspace itself owns: they have no meaning outside it. Personal
  // (USER-owned) agents are untouched; they only lose their grant above.
  await prisma.userDefaultAgent.deleteMany({ where: { workspaceId } });
  await prisma.workspaceDefaultAgent.deleteMany({ where: { workspaceId } });
  const ownedAgentIds = (await prisma.agent.findMany({ where: { ownerType: "WORKSPACE", ownerWorkspaceId: workspaceId }, select: { id: true } })).map((agent) => agent.id);
  if (ownedAgentIds.length) {
    // Credentials issued to these agents die with them rather than outliving the identity they authenticate.
    await prisma.apiKey.deleteMany({ where: { agentId: { in: ownedAgentIds } } });
    await prisma.oAuthToken.deleteMany({ where: { agentId: { in: ownedAgentIds } } });
    await prisma.oAuthAuthorizationCode.deleteMany({ where: { agentId: { in: ownedAgentIds } } });
    await prisma.oAuthConsent.deleteMany({ where: { agentId: { in: ownedAgentIds } } });
    await prisma.agentOrgAdminGrant.deleteMany({ where: { agentId: { in: ownedAgentIds } } });
    await prisma.agent.deleteMany({ where: { id: { in: ownedAgentIds } } });
  }
}
