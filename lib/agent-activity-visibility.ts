import type { Prisma } from "@prisma/client";

/** Null-workspace attempts contain no foreign workspace metadata or arguments. */
export function ownerAgentActivityWhere(userId: string, agentIds: string[], workspaceIds: string[]): Prisma.AgentToolCallWhereInput {
  return { userId, agentId: { in: agentIds }, OR: [{ workspaceId: null }, { workspaceId: { in: workspaceIds } }] };
}
