import type { AppPrismaClient, AppTransactionClient } from "@/lib/db";
import { agentRunsAvailable } from "@/lib/agent-runs";

/** Rejoining a workspace requires a fresh administrator grant. */
export async function revokeMemberAgentGrants(prisma: AppTransactionClient, workspaceId: string, ownerUserId: string) {
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
  if (await agentRunsAvailable(prisma)) {
    const runs = await prisma.agentRun.findMany({ where: { workspaceId }, select: { id: true } });
    if (runs.length) await prisma.agentRunEvent.deleteMany({ where: { runId: { in: runs.map((run) => run.id) } } });
    await prisma.agentRun.deleteMany({ where: { workspaceId } });
  }
  await prisma.agentMessage.deleteMany({ where: { conversation: { workspaceId } } });
  await prisma.agentAuditLog.deleteMany({ where: { workspaceId } });
  await prisma.agentConversation.deleteMany({ where: { workspaceId } });
  await prisma.agentToolCall.deleteMany({ where: { workspaceId } });
  await prisma.agentWorkspaceGrant.deleteMany({ where: { workspaceId } });
}
