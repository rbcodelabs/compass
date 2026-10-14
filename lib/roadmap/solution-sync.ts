/**
 * Keeps the roadmap in step with Discovery.
 *
 * `syncRoadmapOnSolutionChange` runs after a solution's status or title changes,
 * from every path that can change them (the Discovery action, the entity panel,
 * MCP `update_solution_status` / `update_solution`, and the REST API):
 *
 *  - Building (IN_DELIVERY) auto-creates a linked roadmap item, at most once per
 *    solution, flagged `autoCreated`. Validated deliberately does not.
 *  - Linked items follow the solution: title until a human renames the item,
 *    horizon and dates until a human edits the schedule.
 *
 * Removing or archiving a roadmap item never touches the solution. An archived
 * auto-created item is the suppression marker that stops auto-sync re-adding it.
 *
 * The sync is best-effort by contract: the solution change has already
 * committed, so a sync failure is logged and reported, never thrown.
 */
import type { AppPrismaClient } from "@/lib/db";
import { captureWorkspaceMutation } from "@/lib/workspace-update-mutations";
import { planAutoAdd, planLinkedSync } from "@/lib/roadmap/scheduling";
import {
  autoRoadmapItemId,
  createRoadmapItemsFromSolutions,
  utcToday,
  type CreateContext,
} from "@/lib/roadmap/create-from-solution";

export type SolutionChange = {
  solutionId: string;
  workspaceId: string;
  previousStatus?: string | null;
  status?: string;
  previousTitle?: string;
  title?: string;
};

export type SolutionSyncContext = Pick<CreateContext, "source" | "captureSource" | "userId" | "today">;

export type SolutionSyncResult = {
  autoAdded: { itemId: string; workspaceId: string; title: string; start: string | null; end: string | null } | null;
  /** Why auto-add did not run, when status changed but nothing was created. */
  skipped: string | null;
  followed: number;
  error: string | null;
};

const EMPTY: SolutionSyncResult = { autoAdded: null, skipped: null, followed: 0, error: null };

function day(value: Date | null): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}

export async function syncRoadmapOnSolutionChange(
  prisma: AppPrismaClient,
  context: SolutionSyncContext,
  change: SolutionChange,
): Promise<SolutionSyncResult> {
  const result: SolutionSyncResult = { ...EMPTY };
  const today = context.today ?? utcToday();
  try {
    const { solutionId, workspaceId } = change;
    const linked = await prisma.roadmapItem.findMany({
      where: { workspaceId, solutionId },
      select: { id: true, title: true, horizon: true, status: true, startDate: true, endDate: true, scheduleEditedAt: true, autoCreated: true },
    });
    const active = linked.filter((item) => item.status === "ACTIVE");

    if (change.status !== undefined) {
      const plan = planAutoAdd({
        previousStatus: change.previousStatus ?? null,
        status: change.status,
        hasActiveItem: active.length > 0,
        hasAutoTombstone: linked.some((item) => item.autoCreated === true),
      });
      if (plan.create) {
        const created = await createRoadmapItemsFromSolutions(
          prisma,
          { workspaceId, source: context.source, captureSource: context.captureSource, userId: context.userId, today, autoCreated: true },
          [{ solutionId, horizon: "NOW", id: autoRoadmapItemId(solutionId) }],
        );
        const item = created.created[0];
        if (item) result.autoAdded = { itemId: item.id, workspaceId, title: item.title, start: day(item.startDate), end: day(item.endDate) };
        else result.skipped = created.conflicts.length > 0 ? "suppressed" : "already-scheduled";
      } else {
        result.skipped = plan.reason;
      }
    }

    // Items that existed before this change follow the solution. The item just
    // auto-created already reflects it.
    for (const item of active) {
      const patch = planLinkedSync({
        item: {
          title: item.title,
          horizon: item.horizon,
          startDate: day(item.startDate),
          endDate: day(item.endDate),
          scheduleEdited: item.scheduleEditedAt !== null,
        },
        today,
        change: { previousTitle: change.previousTitle, title: change.title, previousStatus: change.previousStatus, status: change.status },
      });
      if (!patch) continue;
      await captureWorkspaceMutation(prisma, "roadmapItem", "update", context.captureSource, item.id, (tx) =>
        tx.roadmapItem.update({
          where: { id: item.id },
          data: {
            updatedAt: new Date(),
            ...(patch.title !== undefined ? { title: patch.title } : {}),
            ...(patch.horizon !== undefined ? { horizon: patch.horizon } : {}),
            ...(patch.startDate !== undefined ? { startDate: new Date(`${patch.startDate}T00:00:00.000Z`) } : {}),
            ...(patch.endDate !== undefined ? { endDate: new Date(`${patch.endDate}T00:00:00.000Z`) } : {}),
          },
        }),
      );
      result.followed += 1;
    }
  } catch (error) {
    console.error("[roadmap] solution sync failed", error);
    result.error = error instanceof Error ? error.message : String(error);
  }
  return result;
}
