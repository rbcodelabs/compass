import type { AppPrismaClient, AppTransactionClient } from "./db";
import getPrisma from "./db";
import { hasToolTransaction } from "./mcp-tool-db";
import { getMcpActivityPrisma } from "./analytics/activity";
import { isModuleEnabled } from "@/lib/modules/server";
import { resetFeatureTablesCache, workspaceUpdatesTablesExist } from "@/lib/feature-tables";
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
/** Test seam: forget the cached positive table-existence answer. */
export function resetWorkspaceUpdatesAvailabilityCache(): void {
  resetFeatureTablesCache();
}

/** The `workspace_updates` module is enabled for the workspace AND the tables exist. */
export async function workspaceUpdatesAvailable(
  prisma: AppPrismaClient,
  workspaceId: string,
): Promise<boolean> {
  if (!(await isModuleEnabled(workspaceId, "workspace_updates"))) return false;
  return workspaceUpdatesTablesExist(prisma);
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
        ["WorkspaceUpdatesState", "WorkspaceUpdatesReadState", "WorkspaceSequence"].includes(
          details.meta?.modelName ?? "",
        );
      if (attempt >= 3 || (!rollbackConflict && !firstRowRace)) throw error;
      await new Promise((resolve) =>
        setTimeout(resolve, 10 * 2 ** attempt + Math.random() * 20),
      );
    }
  }
}

export type WorkspaceUpdatesOptions = {
  /**
   * Run the callback in a transaction even when update capture is off. Set by
   * multi-row writes that must commit together (an opportunity plus its
   * feedback links); a single-row write does not need the extra round trip.
   */
  atomic?: boolean;
};

/**
 * Runs `callback` for a write whose workspace is known up front. `capture` says whether update capture is on for THAT workspace
 * (module enabled and tables present).
 */
export async function withWorkspaceUpdates<T>(
  prisma: AppPrismaClient,
  workspaceId: string,
  callback: (tx: AppTransactionClient, capture: boolean) => Promise<T>,
  options: WorkspaceUpdatesOptions = {},
): Promise<T> {
  // A PM tool may already run inside its receipt transaction. Reuse that
  // transaction (and its commit-scoped analytics), never nest or replay it.
  if (hasToolTransaction()) {
    const enabled = await workspaceUpdatesAvailable(getPrisma(), workspaceId);
    return callback(getMcpActivityPrisma(), enabled);
  }
  if (!(await workspaceUpdatesAvailable(prisma, workspaceId)))
    return options.atomic
      ? retryUpdatesTransaction(prisma, (tx) => callback(tx, false))
      : callback(prisma, false);
  return retryUpdatesTransaction(prisma, (tx) => callback(tx, true));
}

/**
 * Like `withWorkspaceUpdates` for a write whose workspace is only known once it has run (the generic mutation adapter). The
 * transaction is opened whenever the update tables exist; `tablesExist` tells the callback so, and it decides per workspace
 * (`workspaceUpdatesAvailable`-style) once the row it wrote names one.
 */
export async function withUpdatesTables<T>(
  prisma: AppPrismaClient,
  callback: (tx: AppTransactionClient, tablesExist: boolean) => Promise<T>,
  options: WorkspaceUpdatesOptions = {},
): Promise<T> {
  if (hasToolTransaction()) {
    const exist = await workspaceUpdatesTablesExist(getPrisma());
    return callback(getMcpActivityPrisma(), exist);
  }
  if (!(await workspaceUpdatesTablesExist(prisma)))
    return options.atomic
      ? retryUpdatesTransaction(prisma, (tx) => callback(tx, false))
      : callback(prisma, false);
  return retryUpdatesTransaction(prisma, (tx) => callback(tx, true));
}

/** The bounded OCC retry alone, for writes that only need a replayable transaction and never record updates. */
export async function withAtomicRetry<T>(
  prisma: AppPrismaClient,
  callback: (tx: AppTransactionClient) => Promise<T>,
): Promise<T> {
  if (hasToolTransaction()) return callback(getMcpActivityPrisma());
  return retryUpdatesTransaction(prisma, callback);
}
