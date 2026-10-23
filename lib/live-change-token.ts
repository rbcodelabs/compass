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

/**
 * Entity-scoped tokens for docs and artifacts, passed as the same `scope` query
 * param: `doc:<id>`, `artifact:<id>`, or the workspace-level `docs-tree`.
 */
export type EntityLiveTarget =
  | { kind: "doc"; id: string }
  | { kind: "artifact"; id: string }
  | { kind: "docs-tree" };
export type EntityLiveScope = `doc:${string}` | `artifact:${string}` | "docs-tree";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Parses an entity scope; null for anything else (including a malformed id, which must not reach Prisma). */
export function parseEntityScope(value: string | null): EntityLiveTarget | null {
  if (value === "docs-tree") return { kind: "docs-tree" };
  if (value === null) return null;
  const match = /^(doc|artifact):(.+)$/.exec(value);
  if (!match || !UUID_PATTERN.test(match[2])) return null;
  return { kind: match[1] as "doc" | "artifact", id: match[2] };
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

/**
 * Token for one doc, one artifact, or the Docs library tree. Returns null when
 * the entity does not exist *in this workspace*, so a caller cannot probe ids
 * from another workspace (the route answers 404 either way).
 *
 * The doc token never selects `content`: reading it can mean a storage
 * round-trip per poll. `revision` is the content version, but legacy rows have
 * a null revision, so `updatedAt` is hashed as well. Comments contribute their
 * status and updatedAt, never their body.
 */
export async function computeEntityChangeToken(
  target: EntityLiveTarget,
  workspaceId: string,
): Promise<string | null> {
  const prisma = getPrisma();
  switch (target.kind) {
    case "doc": {
      const doc = await prisma.doc.findFirst({
        where: { id: target.id, workspaceId },
        select: { id: true, revision: true, updatedAt: true, docType: true, title: true },
      });
      if (!doc) return null;
      const comments = await prisma.docComment.findMany({
        where: { docId: doc.id },
        select: { id: true, status: true, updatedAt: true },
      });
      return hashRows([[doc], comments]);
    }
    case "artifact": {
      const artifact = await prisma.artifact.findFirst({
        where: { id: target.id, workspaceId },
        select: {
          id: true, currentRevisionId: true, updatedAt: true, status: true, title: true,
          description: true, kind: true,
        },
      });
      if (!artifact) return null;
      return hashRows([[artifact]]);
    }
    case "docs-tree": {
      // Mirrors app/api/docs-tree/route.ts: exactly the fields the Library
      // renders. Doc updatedAt is deliberately absent: it is not displayed and
      // would refetch the tree on every autosave of any doc.
      const [docs, artifacts] = await Promise.all([
        prisma.doc.findMany({
          where: { workspaceId },
          select: { id: true, title: true, icon: true, parentId: true, sortOrder: true, docType: true },
        }),
        prisma.artifact.findMany({
          where: { workspaceId, status: "ACTIVE" },
          select: { id: true, title: true, sourceType: true, updatedAt: true },
        }),
      ]);
      return hashRows([docs, artifacts]);
    }
  }
}
