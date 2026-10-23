import { createHash } from "node:crypto";
import getPrisma from "@/lib/db";
import { loadCardSortBoard } from "@/lib/card-sort";
import { listCardSortNewEntries } from "@/lib/card-sort-new-entries";

/**
 * Cheap "did anything on this board change?" fingerprint for live refresh.
 *
 * The token is a hash over the *displayed* fields of every row that feeds the
 * board (id, status, order, title, updatedAt, ...), not just max(updatedAt).
 * Writers do not reliably bump updatedAt (DSQL has no @updatedAt trigger, and
 * several MCP/server paths update `status` or `sortOrder` without touching it),
 * and a max()+count pair can never see a pure reorder. Hashing the fields means
 * a status move, reorder, rename or delete all change the token no matter which
 * path wrote them. The cost is one narrow SELECT per poll, no joins.
 *
 * The token is scoped to the whole workspace for an object type, not to any
 * page filter: it is a superset signal, so a filtered board may refresh once
 * for a change it cannot see (a harmless no-op re-render), never miss one.
 */
export const LIVE_SCOPES = ["opportunities", "solutions", "tasks", "experiments", "roadmap", "cardSort"] as const;
export type LiveScope = (typeof LIVE_SCOPES)[number];

export function isLiveScope(value: string | null): value is LiveScope {
  return value !== null && (LIVE_SCOPES as readonly string[]).includes(value);
}

/** Order-independent, stable fingerprint of groups of plain rows. */
export function hashRows(groups: ReadonlyArray<ReadonlyArray<unknown>>): string {
  const hash = createHash("sha1");
  for (const rows of groups) {
    const lines = rows.map((row) => JSON.stringify(row)).sort();
    hash.update(`${lines.length}\n`);
    for (const line of lines) hash.update(`${line}\n`);
    hash.update("--\n");
  }
  return hash.digest("hex");
}

/** Per-request context for scopes whose visibility depends on who is asking. */
export type ChangeTokenContext = { userId: string; roundId?: string | null };

export async function computeChangeToken(
  scope: LiveScope,
  workspaceId: string,
  context?: ChangeTokenContext,
): Promise<string> {
  const prisma = getPrisma();
  switch (scope) {
    case "roadmap": {
      const [items, solutions, bugs] = await Promise.all([
        prisma.roadmapItem.findMany({
          where: { workspaceId },
          select: {
            id: true, horizon: true, status: true, sortOrder: true, title: true, squadId: true,
            isPrivate: true, startDate: true, endDate: true, solutionId: true, updatedAt: true,
          },
        }),
        prisma.solution.findMany({
          where: { workspaceId, status: { not: "KILLED" } },
          select: { id: true, title: true, status: true },
        }),
        prisma.feedbackItem.findMany({
          where: { workspaceId, type: "BUG" },
          select: { id: true, title: true },
        }),
      ]);
      // Swimlanes grouped by a custom field read the lane from these values.
      const laneValues = items.length === 0
        ? []
        : await prisma.customFieldValue.findMany({
            where: { objectId: { in: items.map((item) => item.id) } },
            select: { fieldId: true, objectId: true, value: true, updatedAt: true },
          });
      return hashRows([items, solutions, bugs, laneValues]);
    }
    case "cardSort": {
      if (!context?.roundId) throw new Error("cardSort scope requires a roundId");
      // Hash exactly what this user may see (loadCardSortBoard applies the
      // blind-proposal gate), so the token can never reveal a hidden proposal.
      const [board, newEntries] = await Promise.all([
        loadCardSortBoard({ workspaceId, roundId: context.roundId, userId: context.userId }),
        listCardSortNewEntries({ workspaceId, roundId: context.roundId, userId: context.userId }),
      ]);
      return hashRows([
        [board.round],
        board.rows,
        board.proposals,
        newEntries,
      ]);
    }
    case "opportunities": {
      const [opportunities, solutions, evidenceCount] = await Promise.all([
        prisma.opportunity.findMany({
          where: { workspaceId },
          select: { id: true, status: true, sortOrder: true, title: true, customerSegment: true, squadId: true, updatedAt: true },
        }),
        prisma.solution.findMany({
          where: { workspaceId },
          select: { id: true, opportunityId: true, status: true, sortOrder: true, updatedAt: true },
        }),
        prisma.evidence.count({ where: { workspaceId } }),
      ]);
      return hashRows([opportunities, solutions, [evidenceCount]]);
    }
    case "solutions": {
      const [solutions, opportunities] = await Promise.all([
        prisma.solution.findMany({
          where: { workspaceId },
          select: { id: true, opportunityId: true, status: true, sortOrder: true, title: true, updatedAt: true },
        }),
        // Cards show the parent opportunity's title.
        prisma.opportunity.findMany({ where: { workspaceId }, select: { id: true, title: true, status: true } }),
      ]);
      return hashRows([solutions, opportunities]);
    }
    case "experiments": {
      const experiments = await prisma.experiment.findMany({
        where: { workspaceId },
        select: { id: true, status: true, sortOrder: true, title: true, squadId: true, updatedAt: true },
      });
      return hashRows([experiments]);
    }
    case "tasks": {
      const tasks = await prisma.task.findMany({
        where: { workspaceId },
        select: {
          id: true, status: true, sortOrder: true, title: true, priority: true, squadId: true,
          assigneeUserId: true, assigneeAgentId: true, storyPoints: true, dueDate: true,
          parentTaskId: true, updatedAt: true,
        },
      });
      return hashRows([tasks]);
    }
  }
}
