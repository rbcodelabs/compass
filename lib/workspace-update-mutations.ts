import getPrisma from "@/lib/db";
import type { AppPrismaClient, AppTransactionClient } from "@/lib/db";
import { followingTablesExist } from "@/lib/feature-tables";
import { isModuleEnabled } from "@/lib/modules/server";
import { runAfterCommit } from "@/lib/following-commit";
import {
  applyFollowingEffects,
  buildFollowingEffects,
  followingTracksModel,
  type FollowActor,
  type FollowingEffect,
} from "@/lib/following-hooks";
import { getMcpActor } from "@/lib/mcp-authz";
import { withTaskWriteLock } from "@/lib/task-write-lock";
import { detectFieldTransitions } from "@/lib/status-transitions";
import {
  recordWorkspaceUpdate,
  withUpdatesTables,
  type WorkspaceUpdatesOptions,
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
/** Models whose rows carry a human-readable work item ID (lib/work-item-ids.ts). */
const NUMBERED_MODELS: ReadonlySet<Model> = new Set<Model>(["task", "opportunity", "solution", "assumption", "roadmapItem", "experiment"]);
type Row = {
  id: string;
  workspaceId?: string;
  status?: string;
  horizon?: string;
  updatedAt?: Date | string | null;
  assigneeUserId?: string | null;
  assigneeAgentId?: string | null;
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
  // Solution carries its own workspaceId (migration 068) and deliberately has
  // no parent-chain fallback: an event is never attributed to a workspace by
  // way of an Opportunity. A NULL solution workspaceId fails closed below.
  const parent =
    model === "assumption"
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

/**
 * Who a following effect is attributed to. Never throws: a missing session or
 * MCP context must not fail a write just because following is on, so it falls
 * back to SYSTEM (which the emitter treats as nobody to exclude).
 */
async function followActorFor(
  source: "UI" | "MCP" | UpdateActor,
  known: UpdateActor | null,
): Promise<FollowActor> {
  try {
    const actor = known ?? (await workspaceMutationActor(source));
    return { type: actor.actorType, id: actor.actorId };
  } catch {
    return { type: "SYSTEM", id: null };
  }
}

/**
 * Following can matter for this model: its subject type has shipped and the tables exist. Whether the WORKSPACE has the `following`
 * module on is decided later, once the written row names its workspace. The availability probe uses the plain client, never the
 * caller's, because a missing-table error would abort a transaction (and an MCP tool's client is already inside one); only a positive
 * answer is cached, so a model that following does not track costs nothing.
 */
async function followingTablesFor(model: Model): Promise<boolean> {
  if (!followingTracksModel(model)) return false;
  return followingTablesExist(getPrisma());
}

/** Explicit call-site adapter: ordinary edits and ordering emit no events. */
export async function captureWorkspaceMutation<T extends { id: string }>(
  prisma: AppPrismaClient,
  model: Model,
  operation: "create" | "update",
  source: "UI" | "MCP" | UpdateActor,
  id: string | undefined,
  mutate: (tx: AppTransactionClient) => Promise<T>,
  options?: WorkspaceUpdatesOptions,
): Promise<T> {
  // Task updates run one at a time per task so each write's "before" status is the previous write's result
  // (see lib/task-write-lock.ts); everything else goes straight through.
  if (model === "task" && operation === "update" && id) {
    return withTaskWriteLock(id, () => captureUnlocked(prisma, model, operation, source, id, mutate, options));
  }
  return captureUnlocked(prisma, model, operation, source, id, mutate, options);
}

async function captureUnlocked<T extends { id: string }>(
  prisma: AppPrismaClient,
  model: Model,
  operation: "create" | "update",
  source: "UI" | "MCP" | UpdateActor,
  id: string | undefined,
  mutate: (tx: AppTransactionClient) => Promise<T>,
  options?: WorkspaceUpdatesOptions,
): Promise<T> {
  const followingTables = await followingTablesFor(model);
  let pending: FollowingEffect[] = [];
  // Status a task held before this write, for the Doc comment thread sync below.
  const taskBefore: { status: string | null } = { status: null };

  const result = await withUpdatesTables(
    prisma,
    async (tx, updatesTables) => {
      // This callback can replay on a rolled-back attempt; only the attempt
      // that commits may leave effects behind.
      pending = [];
      taskBefore.status = null;
      if (model === "task" && operation === "update" && id) {
        // Best-effort: the thread sync is a side effect and must never block the task edit itself.
        try {
          taskBefore.status = (await tx.task.findUnique({ where: { id }, select: { status: true } }))?.status ?? null;
        } catch (error) {
          console.error("[comment-task-sync] could not read previous task status", error);
        }
      }
      if (!updatesTables && !followingTables) return mutate(tx);
      const before =
        operation === "update" && id ? await readRow(tx, model, id) : null;
      const result = await mutate(tx);
      const after = result as Row;
      // The row just written names its workspace; the modules are that workspace's. A callback that returns a narrow row (a select of
      // `id` only) is attributed through the row as it was before the write instead. A write that still cannot be attributed to a
      // workspace is neither captured nor followed: with the gate per workspace there is no module to consult, and failing the user's
      // edit for bookkeeping would be worse. It is logged so it is visible.
      let workspaceId: string | null = null;
      for (const candidate of [after, before]) {
        if (!candidate || workspaceId) continue;
        try {
          workspaceId = await scope(tx, model, candidate);
        } catch {
          /* try the next candidate */
        }
      }
      if (!workspaceId) {
        console.warn("[workspace-updates] write has no attributable workspace; not captured", { model, operation, id: after.id });
        return result;
      }
      const enabled =
        updatesTables &&
        workspaceId !== null &&
        (await isModuleEnabled(workspaceId, "workspace_updates"));
      const following =
        followingTables &&
        workspaceId !== null &&
        (await isModuleEnabled(workspaceId, "following"));
      if (!enabled && !following) return result;
      const updateActor = enabled ? await workspaceMutationActor(source) : null;
      const followActor = following
        ? await followActorFor(source, updateActor)
        : null;
      const changed = detectFieldTransitions(model, before, after);
      if (followActor) {
        try {
          pending = await buildFollowingEffects({
            model,
            operation,
            before,
            after,
            actor: followActor,
            transitions: changed,
            workspaceId: async () => workspaceId!,
          });
        } catch (error) {
          // Best-effort by contract: a following problem never fails the edit.
          console.error("[following] could not plan effects", error);
          pending = [];
        }
      }
      if (!enabled) return result;
      const actor = updateActor!;
      return recordUpdates(tx, model, operation, actor, before, after, changed, result, workspaceId!);
    },
    // A numbered create allocates its work item ID from the workspace counter in the same transaction as the
    // insert (lib/work-item-sequence.ts), so it must always run in a replayable transaction, capture or not.
    operation === "create" && NUMBERED_MODELS.has(model)
      ? { ...options, atomic: true }
      : options,
  );
  const statusAfter = (result as { status?: string } | undefined)?.status;
  if (model === "task" && taskBefore.status !== null && statusAfter !== undefined) {
    const [from, to] = [taskBefore.status, statusAfter];
    if (from !== to && (from === "DONE" || to === "DONE")) {
      // Lazy import: the sync reaches lib/comments, which imports this module.
      await runAfterCommit(async () => (await import("@/lib/comment-task-sync")).syncCommentThreadsForTaskStatus(result.id, from, to));
    }
  }
  if (pending.length > 0) {
    const effects = pending;
    // After the commit; queued until the outer transaction commits for MCP
    // tools that run inside the PM interview receipt transaction.
    await runAfterCommit(() => applyFollowingEffects(effects));
  }
  return result;
}

async function recordUpdates<T extends { id: string }>(
  tx: AppTransactionClient,
  model: Model,
  operation: "create" | "update",
  actor: UpdateActor,
  before: Row | null,
  after: Row,
  changed: ReturnType<typeof detectFieldTransitions>,
  result: T,
  workspaceId: string,
): Promise<T> {
  {
    const evidenceAttached =
      model === "evidence" &&
      ["opportunityId", "solutionId", "assumptionId"].some((field) => {
        const key = field as "opportunityId" | "solutionId" | "assumptionId";
        return after[key] != null && after[key] !== before?.[key];
      });
    if (operation === "update" && changed.length === 0 && !evidenceAttached)
      return result;
    const entityType: string = types[model];
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
      for (const transition of changed)
        await recordWorkspaceUpdate(tx, {
          workspaceId,
          entityType,
          entityId,
          groupType,
          groupId,
          kind: "STATUS_CHANGED",
          before: transition.from,
          after: transition.to,
          ...actor,
        });
    }
    return result;
  }
}
