import getPrisma from "@/lib/db";
import type { AppPrismaClient, AppTransactionClient } from "@/lib/db";
import { followingAvailable, followingEnabled } from "@/lib/following-flag";
import { runAfterCommit } from "@/lib/following-commit";
import {
  applyFollowingEffects,
  buildFollowingEffects,
  followingTracksModel,
  type FollowActor,
  type FollowingEffect,
} from "@/lib/following-hooks";
import { getMcpActor } from "@/lib/mcp-authz";
import { detectFieldTransitions } from "@/lib/status-transitions";
import {
  recordWorkspaceUpdate,
  withWorkspaceUpdates,
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
 * Following is on, available, and this model's subject type has shipped. The
 * flag check is synchronous and first, so with FOLLOWING_ENABLED off this costs
 * nothing: no read, no auth() call. The availability probe uses the plain
 * client, never the caller's, because a missing-table error would abort a
 * transaction (and an MCP tool's client is already inside one).
 */
async function followingActiveFor(model: Model): Promise<boolean> {
  if (!followingEnabled() || !followingTracksModel(model)) return false;
  return followingAvailable(getPrisma());
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
  const following = await followingActiveFor(model);
  let pending: FollowingEffect[] = [];
  const result = await withWorkspaceUpdates(
    prisma,
    async (tx, enabled) => {
      // This callback can replay on a rolled-back attempt; only the attempt
      // that commits may leave effects behind.
      pending = [];
      if (!enabled && !following) return mutate(tx);
      const updateActor = enabled ? await workspaceMutationActor(source) : null;
      const followActor = following
        ? await followActorFor(source, updateActor)
        : null;
      const before =
        operation === "update" && id ? await readRow(tx, model, id) : null;
      const result = await mutate(tx);
      const after = result as Row;
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
            workspaceId: () => scope(tx, model, after),
          });
        } catch (error) {
          // Best-effort by contract: a following problem never fails the edit.
          console.error("[following] could not plan effects", error);
          pending = [];
        }
      }
      if (!enabled) return result;
      const actor = updateActor!;
      return recordUpdates(tx, model, operation, actor, before, after, changed, result);
    },
    options,
  );
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
    const workspaceId = await scope(tx, model, after);
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
