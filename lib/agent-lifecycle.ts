import type { AppPrismaClient, AppTransactionClient } from "@/lib/db";

/** Rejoining a workspace requires a fresh administrator grant. */
export async function revokeMemberAgentGrants(prisma: AppTransactionClient, workspaceId: string, ownerUserId: string) {
  const agents = await prisma.agent.findMany({ where: { ownerUserId }, select: { id: true } });
  if (agents.length) await prisma.agentWorkspaceGrant.updateMany({ where: { workspaceId, agentId: { in: agents.map((a) => a.id) }, revokedAt: null }, data: { revokedAt: new Date(), updatedAt: new Date() } });
}

/** This schema uses application-managed relations. Personal identities outlive workspaces. */
export async function deleteWorkspaceAgentData(prisma: AppPrismaClient, workspaceId: string) {
  await prisma.agentToolCall.deleteMany({ where: { workspaceId } });
  await prisma.agentWorkspaceGrant.deleteMany({ where: { workspaceId } });
}
