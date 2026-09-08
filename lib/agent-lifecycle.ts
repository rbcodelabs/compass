import type { Prisma, PrismaClient } from "@prisma/client";

/** Rejoining a workspace requires a fresh administrator grant. */
export async function revokeMemberAgentGrants(prisma: Prisma.TransactionClient, workspaceId: string, ownerUserId: string) {
  const agents = await prisma.agent.findMany({ where: { ownerUserId }, select: { id: true } });
  if (agents.length) await prisma.agentWorkspaceGrant.updateMany({ where: { workspaceId, agentId: { in: agents.map((a) => a.id) }, revokedAt: null }, data: { revokedAt: new Date(), updatedAt: new Date() } });
}

/** DSQL has no FK cascades. Personal agents and keys outlive any workspace. */
export async function deleteWorkspaceAgentData(prisma: PrismaClient, workspaceId: string) {
  await prisma.agentToolCall.deleteMany({ where: { workspaceId } });
  await prisma.agentWorkspaceGrant.deleteMany({ where: { workspaceId } });
}
