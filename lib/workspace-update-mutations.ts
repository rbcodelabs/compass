import type { AppPrismaClient, AppTransactionClient } from "@/lib/db";
import { getMcpActor } from "@/lib/mcp-authz";
import {
  recordWorkspaceUpdate,
  withWorkspaceUpdates,
} from "@/lib/workspace-updates-capture";

const types = {
  task: "TASK",
  opportunity: "OPPORTUNITY",
  solution: "SOLUTION",
  assumption: "ASSUMPTION",
  roadmapItem: "ROADMAP_ITEM",
  experiment: "EXPERIMENT",
  experimentResult: "EXPERIMENT",
  evidence: "EVIDENCE",
} as const;
type Model = keyof typeof types;
type Row = {
  id: string;
  workspaceId?: string;
  status?: string;
  horizon?: string;
  parentTaskId?: string | null;
  opportunityId?: string | null;
  solutionId?: string | null;
  assumptionId?: string | null;
  experimentId?: string | null;
};

type UpdateActor = {
  actorType: "USER" | "AGENT" | "SYSTEM";
  actorId: string | null;
};
export async function workspaceMutationActor(
  source: "UI" | "MCP" | UpdateActor,
) {
  if (typeof source !== "string") return source;
  if (source === "MCP") {
    const actor = getMcpActor();
    if (
      (actor.purpose === "AGENT" || actor.purpose === "AGENT_TURN") &&
      actor.agentId
    )
      return { actorType: "AGENT" as const, actorId: actor.agentId };
    if ((!actor.purpose || actor.purpose === "USER") && actor.userId)
      return { actorType: "USER" as const, actorId: actor.userId };
    return { actorType: "SYSTEM" as const, actorId: null };
  }
  const { auth } = await import("@/auth");
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  return { actorType: "USER" as const, actorId: session.user.id };
}

async function readRow(
  tx: AppTransactionClient,
  model: Model,
  id: string,
): Promise<Row | null> {
  // Only the explicit models above can enter this adapter. Their common scalar
  // read contract is narrower than Prisma's model-specific generated overloads.
  const delegate = tx[model] as unknown as {
    findUnique(args: { where: { id: string } }): Promise<Row | null>;
  };
  return delegate.findUnique({ where: { id } });
}

async function scope(
  tx: AppTransactionClient,
  model: Model,
  row: Row,
): Promise<string> {
  if (row.workspaceId) return row.workspaceId;
  const parent =
    model === "solution"
      ? (["opportunity", row.opportunityId] as const)
      : model === "assumption"
        ? (["solution", row.solutionId] as const)
        : model === "experimentResult"
          ? (["experiment", row.experimentId] as const)
          : null;
  if (parent?.[1]) {
    const record = await readRow(tx, parent[0], parent[1]);
    if (record) return scope(tx, parent[0], record);
  }
  throw new Error("Workspace update source has no workspace");
}

/** Explicit call-site adapter: ordinary edits and ordering emit no events. */
export async function captureWorkspaceMutation<T extends { id: string }>(
  prisma: AppPrismaClient,
  model: Model,
  operation: "create" | "update",
  source: "UI" | "MCP" | UpdateActor,
  id: string | undefined,
  mutate: (tx: AppTransactionClient) => Promise<T>,
): Promise<T> {
  return withWorkspaceUpdates(prisma, async (tx, enabled) => {
    if (!enabled) return mutate(tx);
    const actor = await workspaceMutationActor(source);
    const before =
      operation === "update" && id ? await readRow(tx, model, id) : null;
    const result = await mutate(tx);
    const after = result as Row;
    const fields =
      model === "roadmapItem"
        ? (["status", "horizon"] as const)
        : (["status"] as const);
    const changed = fields.filter(
      (field) => before?.[field] !== after[field] && after[field] !== undefined,
    );
    const evidenceAttached =
      model === "evidence" &&
      ["opportunityId", "solutionId", "assumptionId"].some((field) => {
        const key = field as "opportunityId" | "solutionId" | "assumptionId";
        return after[key] != null && after[key] !== before?.[key];
      });
    if (operation === "update" && changed.length === 0 && !evidenceAttached)
      return result;
    const workspaceId = await scope(tx, model, after);
    let entityType: string = types[model];
    let entityId = after.id;
    let groupType: string = entityType;
    let groupId = after.id;
    if (model === "task" && after.parentTaskId) groupId = after.parentTaskId;
    if (model === "experimentResult" && after.experimentId)
      entityId = groupId = after.experimentId;
    if (model === "evidence") {
      const target = after.opportunityId
        ? ["OPPORTUNITY", after.opportunityId]
        : after.solutionId
          ? ["SOLUTION", after.solutionId]
          : after.assumptionId
            ? ["ASSUMPTION", after.assumptionId]
            : null;
      if (target) [groupType, groupId] = target;
    }
    if (operation === "create" || evidenceAttached) {
      await recordWorkspaceUpdate(tx, {
        workspaceId,
        entityType,
        entityId,
        groupType,
        groupId,
        kind:
          model === "evidence"
            ? "EVIDENCE_ADDED"
            : model === "experimentResult"
              ? "RESULT_ADDED"
              : "CREATED",
        ...actor,
      });
    } else {
      for (const field of changed)
        await recordWorkspaceUpdate(tx, {
          workspaceId,
          entityType,
          entityId,
          groupType,
          groupId,
          kind: "STATUS_CHANGED",
          before: before?.[field],
          after: after[field],
          ...actor,
        });
    }
    return result;
  });
}
