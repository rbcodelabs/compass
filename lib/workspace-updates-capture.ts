import type { AppPrismaClient, AppTransactionClient } from "./db";
import getPrisma from "./db";
import { hasToolTransaction } from "./mcp-tool-db";
import { getMcpActivityPrisma } from "./analytics/activity";
export interface WorkspaceUpdateInput {
  workspaceId: string;
  entityType: string;
  entityId: string;
  groupType?: string;
  groupId?: string;
  kind: string;
  actorType: "USER" | "AGENT" | "SYSTEM";
  actorId?: string | null;
  before?: string | null;
  after?: string | null;
}
export async function workspaceUpdatesAvailable(
  prisma: AppPrismaClient,
): Promise<boolean> {
  if (process.env.WORKSPACE_UPDATES_ENABLED !== "1") return false;
  const database = hasToolTransaction() ? getPrisma() : prisma;
  try {
    await Promise.all([
      database.workspaceUpdatesState.findFirst({
        select: { workspaceId: true },
      }),
      database.workspaceUpdateEvent.findFirst({ select: { id: true } }),
      database.workspaceUpdatesReadState.findFirst({ select: { id: true } }),
    ]);
    return true;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "P2021"
    )
      return false;
    throw error;
  }
}

export async function recordWorkspaceUpdate(
  tx: AppTransactionClient,
  input: WorkspaceUpdateInput,
): Promise<void> {
  if (input.kind === "STATUS_CHANGED" && input.before === input.after) return;
  const counter = await tx.workspaceUpdatesState.upsert({
    where: { workspaceId: input.workspaceId },
    create: { workspaceId: input.workspaceId, revision: 1 },
    update: { revision: { increment: 1 } },
  });
  await tx.workspaceUpdateEvent.create({
    data: {
      ...input,
      groupType: input.groupType ?? input.entityType,
      groupId: input.groupId ?? input.entityId,
      revision: counter.revision,
    },
  });
}

export async function retryUpdatesTransaction<T>(
  prisma: AppPrismaClient,
  callback: (tx: AppTransactionClient) => Promise<T>,
): Promise<T> {
  if (hasToolTransaction()) return callback(getMcpActivityPrisma());
  for (let attempt = 0; ; attempt++) {
    try {
      return await prisma.$transaction(callback);
    } catch (error) {
      // Only a known rolled-back transaction may be replayed; never retry network/commit ambiguity.
      const details = error as {
        code?: string;
        meta?: { code?: string; modelName?: string };
        cause?: { code?: string };
      };
      const codes = [details?.code, details?.meta?.code, details?.cause?.code];
      const rollbackConflict = codes.some(
        (code) => code && ["P2034", "40001", "OC000", "OC001"].includes(code),
      );
      const firstRowRace =
        details?.code === "P2002" &&
        ["WorkspaceUpdatesState", "WorkspaceUpdatesReadState"].includes(
          details.meta?.modelName ?? "",
        );
      if (attempt >= 3 || (!rollbackConflict && !firstRowRace)) throw error;
      await new Promise((resolve) =>
        setTimeout(resolve, 10 * 2 ** attempt + Math.random() * 20),
      );
    }
  }
}

export async function withWorkspaceUpdates<T>(
  prisma: AppPrismaClient,
  callback: (tx: AppTransactionClient, capture: boolean) => Promise<T>,
): Promise<T> {
  // A PM tool may already run inside its receipt transaction. Reuse that
  // transaction (and its commit-scoped analytics), never nest or replay it.
  if (hasToolTransaction()) {
    const enabled = await workspaceUpdatesAvailable(getPrisma());
    return callback(getMcpActivityPrisma(), enabled);
  }
  if (!(await workspaceUpdatesAvailable(prisma)))
    return callback(prisma, false);
  return retryUpdatesTransaction(prisma, (tx) => callback(tx, true));
}
