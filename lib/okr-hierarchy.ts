import getPrisma from "@/lib/db";
import { NO_CYCLE_LABEL } from "@/lib/okr-cycle-scope";
import { runTypedLinkTransaction, syncLegacyLink } from "@/lib/typed-links";

/**
 * Cycle fields are null (title NO_CYCLE_LABEL) for an Objective with no cycle
 * (migration 070). Such an Objective is "persistent": cycle date containment and
 * the CLOSED-cycle rule do not apply to it, in either direction.
 */
export type ParentKeyResultOption = {
  id: string;
  title: string;
  objectiveId: string;
  objectiveTitle: string;
  cycleId: string | null;
  cycleTitle: string;
  cycleStatus: string | null;
  cycleStartDate: Date | null;
  cycleEndDate: Date | null;
};

export type SupportingObjectiveOption = {
  id: string;
  title: string;
  cycleId: string | null;
  cycleTitle: string;
  cycleStartDate: Date | null;
  cycleEndDate: Date | null;
};

export class OKRHierarchyError extends Error {
  constructor(
    public readonly code:
      | "OBJECTIVE_NOT_FOUND"
      | "KEY_RESULT_NOT_FOUND"
      | "SAME_OBJECTIVE"
      | "INVALID_TIME_HORIZON"
      | "CLOSED_PARENT_CYCLE"
      | "CIRCULAR_HIERARCHY",
    message: string
  ) {
    super(message);
    this.name = "OKRHierarchyError";
  }
}

type CycleDates = { startDate: Date; endDate: Date };

function sameDates(a: CycleDates, b: CycleDates): boolean {
  return a.startDate.getTime() === b.startDate.getTime() && a.endDate.getTime() === b.endDate.getTime();
}

/**
 * Return KRs that can be supported by Objectives in `childCycleId`.
 *
 * With a child cycle: KRs from longer-horizon open cycles that fully contain it,
 * plus KRs of cycle-less Objectives (containment skipped). Cycle dates, rather
 * than title conventions, make this work for calendar years, fiscal years,
 * quarters, months, and custom planning periods.
 *
 * With `childCycleId === null` (the child Objective has no cycle): there are no
 * dates to contain, so every KR of an open-cycle or cycle-less Objective in the
 * workspace qualifies. Pass `excludeObjectiveId` to leave out the child's own KRs.
 */
export async function getEligibleParentKeyResults(
  workspaceId: string,
  childCycleId: string | null,
  options: { excludeObjectiveId?: string } = {}
): Promise<ParentKeyResultOption[]> {
  const prisma = getPrisma();
  const childCycle = childCycleId
    ? await prisma.oKRCycle.findFirst({
        where: { id: childCycleId, workspaceId },
        select: { id: true, startDate: true, endDate: true },
      })
    : null;

  if (childCycleId && !childCycle) return [];

  const parentCycleFilter = childCycle
    ? {
        id: { not: childCycle.id },
        status: { in: ["DRAFT", "ACTIVE"] },
        startDate: { lte: childCycle.startDate },
        endDate: { gte: childCycle.endDate },
      }
    : { status: { in: ["DRAFT", "ACTIVE"] } };

  const keyResults = await prisma.keyResult.findMany({
    where: {
      objective: {
        // Tenant scope is the Objective's own workspaceId (migration 068); the
        // cycle filter below only selects the time window.
        workspaceId,
        ...(options.excludeObjectiveId ? { id: { not: options.excludeObjectiveId } } : {}),
        OR: [{ cycleId: null }, { cycle: parentCycleFilter }],
      },
    },
    include: {
      objective: {
        select: {
          id: true,
          title: true,
          sortOrder: true,
          cycle: {
            select: {
              id: true,
              title: true,
              status: true,
              startDate: true,
              endDate: true,
            },
          },
        },
      },
    },
    orderBy: [{ objective: { cycle: { startDate: "desc" } } }, { sortOrder: "asc" }],
  });

  return keyResults
    .filter(
      (kr) => !childCycle || !kr.objective.cycle || !sameDates(kr.objective.cycle, childCycle)
    )
    .map((kr) => ({
      id: kr.id,
      title: kr.title,
      objectiveId: kr.objective.id,
      objectiveTitle: kr.objective.title,
      cycleId: kr.objective.cycle?.id ?? null,
      cycleTitle: kr.objective.cycle?.title ?? NO_CYCLE_LABEL,
      cycleStatus: kr.objective.cycle?.status ?? null,
      cycleStartDate: kr.objective.cycle?.startDate ?? null,
      cycleEndDate: kr.objective.cycle?.endDate ?? null,
      objectiveSortOrder: kr.objective.sortOrder,
      keyResultSortOrder: kr.sortOrder,
    }))
    .sort((a, b) => {
      // Active cycles first, then other cycles, then cycle-less parents.
      const rank = (status: string | null) => (status === "ACTIVE" ? 2 : status ? 1 : 0);
      const status = rank(b.cycleStatus) - rank(a.cycleStatus);
      if (status !== 0) return status;
      const span = (o: { cycleStartDate: Date | null; cycleEndDate: Date | null }) =>
        o.cycleStartDate && o.cycleEndDate ? o.cycleEndDate.getTime() - o.cycleStartDate.getTime() : 0;
      return (
        span(a) - span(b) ||
        a.objectiveSortOrder - b.objectiveSortOrder ||
        a.keyResultSortOrder - b.keyResultSortOrder ||
        a.id.localeCompare(b.id)
      );
    })
    .map((kr) => ({
      id: kr.id,
      title: kr.title,
      objectiveId: kr.objectiveId,
      objectiveTitle: kr.objectiveTitle,
      cycleId: kr.cycleId,
      cycleTitle: kr.cycleTitle,
      cycleStatus: kr.cycleStatus,
      cycleStartDate: kr.cycleStartDate,
      cycleEndDate: kr.cycleEndDate,
    }));
}

/**
 * Return unlinked Objectives that could support a KR of the parent cycle:
 * those in strictly shorter cycles contained by it, plus cycle-less Objectives.
 * With `parentCycleId === null` (the parent Objective has no cycle) every
 * unlinked Objective in the workspace is a candidate; the caller removes the
 * parent's own Objective.
 */
export async function getEligibleSupportingObjectives(
  workspaceId: string,
  parentCycleId: string | null
): Promise<SupportingObjectiveOption[]> {
  const prisma = getPrisma();
  const parentCycle = parentCycleId
    ? await prisma.oKRCycle.findFirst({
        where: { id: parentCycleId, workspaceId },
        select: { id: true, status: true, startDate: true, endDate: true },
      })
    : null;

  if (parentCycleId && (!parentCycle || parentCycle.status === "CLOSED")) return [];

  const objectives = await prisma.objective.findMany({
    where: {
      parentKeyResultId: null,
      workspaceId,
      ...(parentCycle
        ? {
            OR: [
              { cycleId: null },
              {
                cycle: {
                  id: { not: parentCycle.id },
                  startDate: { gte: parentCycle.startDate },
                  endDate: { lte: parentCycle.endDate },
                },
              },
            ],
          }
        : {}),
    },
    include: {
      cycle: {
        select: { id: true, title: true, startDate: true, endDate: true },
      },
    },
    orderBy: [{ cycle: { startDate: "asc" } }, { sortOrder: "asc" }],
  });

  return objectives
    .filter(
      (objective) => !parentCycle || !objective.cycle || !sameDates(objective.cycle, parentCycle)
    )
    .map((objective) => ({
      id: objective.id,
      title: objective.title,
      cycleId: objective.cycle?.id ?? null,
      cycleTitle: objective.cycle?.title ?? NO_CYCLE_LABEL,
      cycleStartDate: objective.cycle?.startDate ?? null,
      cycleEndDate: objective.cycle?.endDate ?? null,
    }));
}

/** Set or clear an Objective's higher-level parent KR with all graph invariants enforced. */
export async function setObjectiveParentKeyResult(input: {
  workspaceId: string;
  objectiveId: string;
  keyResultId: string | null;
}) {
  const prisma = getPrisma();
  const child = await prisma.objective.findFirst({
    where: { id: input.objectiveId, workspaceId: input.workspaceId },
    include: { cycle: true },
  });

  if (!child) {
    throw new OKRHierarchyError("OBJECTIVE_NOT_FOUND", "Objective not found in this workspace.");
  }

  if (input.keyResultId === null) {
    return prisma.objective.update({
      where: { id: child.id },
      data: { parentKeyResultId: null, updatedAt: new Date() },
    });
  }

  const parent = await prisma.keyResult.findFirst({
    where: {
      id: input.keyResultId,
      objective: { workspaceId: input.workspaceId },
    },
    include: { objective: { include: { cycle: true } } },
  });

  if (!parent) {
    throw new OKRHierarchyError("KEY_RESULT_NOT_FOUND", "Key Result not found in this workspace.");
  }
  if (parent.objectiveId === child.id) {
    throw new OKRHierarchyError("SAME_OBJECTIVE", "An Objective cannot support one of its own Key Results.");
  }
  const parentCycle = parent.objective.cycle;
  const childCycle = child.cycle;
  if (parentCycle?.status === "CLOSED") {
    throw new OKRHierarchyError("CLOSED_PARENT_CYCLE", "A closed cycle cannot receive new supporting Objectives.");
  }

  // Containment only applies when both Objectives have a cycle. A cycle-less
  // Objective on either side has no dates to compare, so the check is skipped.
  if (parentCycle && childCycle) {
    const containsChild =
      parentCycle.startDate <= childCycle.startDate && parentCycle.endDate >= childCycle.endDate;
    const isLongerHorizon =
      parentCycle.startDate < childCycle.startDate || parentCycle.endDate > childCycle.endDate;
    if (!containsChild || !isLongerHorizon) {
      throw new OKRHierarchyError(
        "INVALID_TIME_HORIZON",
        "The parent KR must belong to a longer cycle that fully contains this Objective's cycle."
      );
    }
  }

  // Walk the proposed parent's ancestry. The child appearing anywhere above
  // it would close a loop in the alternating Objective -> KR -> Objective graph.
  let cursorObjectiveId: string | null = parent.objectiveId;
  const visited = new Set<string>();
  for (let depth = 0; cursorObjectiveId && depth < 50; depth += 1) {
    if (cursorObjectiveId === child.id) {
      throw new OKRHierarchyError("CIRCULAR_HIERARCHY", "This relationship would create an OKR hierarchy cycle.");
    }
    if (visited.has(cursorObjectiveId)) {
      throw new OKRHierarchyError("CIRCULAR_HIERARCHY", "The existing OKR hierarchy contains a cycle.");
    }
    visited.add(cursorObjectiveId);
    const cursor: { parentKeyResult: { objectiveId: string } | null } | null =
      await prisma.objective.findUnique({
      where: { id: cursorObjectiveId },
      select: { parentKeyResult: { select: { objectiveId: true } } },
      });
    cursorObjectiveId = cursor?.parentKeyResult?.objectiveId ?? null;
  }
  if (cursorObjectiveId) {
    throw new OKRHierarchyError("CIRCULAR_HIERARCHY", "The OKR hierarchy exceeds the supported depth.");
  }

  return prisma.objective.update({
    where: { id: child.id },
    data: { parentKeyResultId: parent.id, updatedAt: new Date() },
  });
}

// ─── Move a Key Result to a different Objective ──────────────────────────────

type CycleWindow = { startDate: Date; endDate: Date } | null;

/** True when `parent` fully contains `child` and is strictly longer. A missing cycle on either side skips the check. */
function cycleFitsUnder(parent: CycleWindow, child: CycleWindow): boolean {
  if (!parent || !child) return true;
  const contains = parent.startDate <= child.startDate && parent.endDate >= child.endDate;
  const longer = parent.startDate < child.startDate || parent.endDate > child.endDate;
  return contains && longer;
}

/** Hard ceiling on opportunities re-linked in one transaction (DSQL caps a transaction's modified rows). */
const MAX_MOVE_OPPORTUNITIES = 400;

export type KeyResultMoveTarget = {
  id: string;
  title: string;
  cycleId: string | null;
  cycleTitle: string;
};

/**
 * Objectives a Key Result can be moved to: same workspace, not its current Objective, not in a closed cycle,
 * not below it in the hierarchy (that would close a loop), and with a cycle that still contains every
 * Objective supporting the Key Result. `moveKeyResultToObjective` re-checks all of this when the move happens.
 */
export async function getKeyResultMoveTargets(workspaceId: string, keyResultId: string): Promise<KeyResultMoveTarget[]> {
  const prisma = getPrisma();
  const keyResult = await prisma.keyResult.findFirst({
    where: { id: keyResultId, objective: { workspaceId } },
    select: { objectiveId: true, objective: { select: { cycleId: true } } },
  });
  if (!keyResult) throw new OKRHierarchyError("KEY_RESULT_NOT_FOUND", "Key Result not found in this workspace.");

  // Everything below the Key Result: its supporting Objectives, their Key Results' supporters, and so on.
  const supporters = await prisma.objective.findMany({
    where: { parentKeyResultId: keyResultId, workspaceId },
    select: { id: true, cycle: { select: { startDate: true, endDate: true } } },
  });
  const descendants = new Set<string>(supporters.map((o) => o.id));
  let frontier = supporters.map((o) => o.id);
  for (let depth = 0; frontier.length > 0 && depth < 50; depth += 1) {
    const next = await prisma.objective.findMany({
      where: { workspaceId, parentKeyResult: { objectiveId: { in: frontier } } },
      select: { id: true },
    });
    frontier = next.map((o) => o.id).filter((id) => !descendants.has(id));
    frontier.forEach((id) => descendants.add(id));
  }

  const candidates = await prisma.objective.findMany({
    where: {
      workspaceId,
      id: { not: keyResult.objectiveId },
      OR: [{ cycleId: null }, { cycle: { status: { not: "CLOSED" } } }],
    },
    select: {
      id: true,
      title: true,
      sortOrder: true,
      cycleId: true,
      cycle: { select: { title: true, startDate: true, endDate: true } },
    },
  });

  return candidates
    .filter((objective) => !descendants.has(objective.id))
    .filter((objective) => supporters.every((s) => cycleFitsUnder(objective.cycle, s.cycle)))
    .sort((a, b) => {
      const sameA = a.cycleId === keyResult.objective.cycleId ? 0 : 1;
      const sameB = b.cycleId === keyResult.objective.cycleId ? 0 : 1;
      return (
        sameA - sameB ||
        (b.cycle?.startDate.getTime() ?? 0) - (a.cycle?.startDate.getTime() ?? 0) ||
        a.sortOrder - b.sortOrder ||
        a.id.localeCompare(b.id)
      );
    })
    .map((objective) => ({
      id: objective.id,
      title: objective.title,
      cycleId: objective.cycleId,
      cycleTitle: objective.cycle?.title ?? NO_CYCLE_LABEL,
    }));
}

/**
 * Re-parent a Key Result under another Objective, in one transaction:
 *   - both rows must be in `workspaceId`, and the target must be a different Objective in an open (or no) cycle;
 *   - the target's cycle must still contain every Objective that supports this Key Result;
 *   - the target must not sit below the Key Result (its ancestry is walked, as in setObjectiveParentKeyResult);
 *   - the Key Result goes to the end of the target's list;
 *   - Opportunities pointing at the Key Result get their implied (LEGACY) Objective link moved with it.
 * Solution links are keyed by Key Result and need no change; DIRECT Opportunity links are the user's and stay.
 */
export async function moveKeyResultToObjective(input: {
  workspaceId: string;
  keyResultId: string;
  objectiveId: string;
  actorId?: string | null;
}) {
  return runTypedLinkTransaction(getPrisma(), async (tx) => {
    const keyResult = await tx.keyResult.findFirst({
      where: { id: input.keyResultId, objective: { workspaceId: input.workspaceId } },
      select: { id: true, objectiveId: true },
    });
    if (!keyResult) throw new OKRHierarchyError("KEY_RESULT_NOT_FOUND", "Key Result not found in this workspace.");

    const target = await tx.objective.findFirst({
      where: { id: input.objectiveId, workspaceId: input.workspaceId },
      include: { cycle: true },
    });
    if (!target) throw new OKRHierarchyError("OBJECTIVE_NOT_FOUND", "Objective not found in this workspace.");
    if (target.id === keyResult.objectiveId) {
      throw new OKRHierarchyError("SAME_OBJECTIVE", "This Key Result already belongs to that Objective.");
    }
    if (target.cycle?.status === "CLOSED") {
      throw new OKRHierarchyError("CLOSED_PARENT_CYCLE", "A closed cycle cannot receive Key Results.");
    }

    const supporters = await tx.objective.findMany({
      where: { parentKeyResultId: keyResult.id, workspaceId: input.workspaceId },
      select: { id: true, cycle: { select: { startDate: true, endDate: true } } },
    });
    if (!supporters.every((s) => cycleFitsUnder(target.cycle, s.cycle))) {
      throw new OKRHierarchyError(
        "INVALID_TIME_HORIZON",
        "The target Objective's cycle must be longer than, and fully contain, the cycles of the Objectives supporting this Key Result."
      );
    }

    // Walk up from the target. Reaching this Key Result means the target is (transitively) supporting it,
    // and moving the Key Result under it would close a loop.
    let cursor: string | null = target.id;
    const visited = new Set<string>();
    for (let depth = 0; cursor && depth < 50; depth += 1) {
      if (visited.has(cursor)) {
        throw new OKRHierarchyError("CIRCULAR_HIERARCHY", "The existing OKR hierarchy contains a cycle.");
      }
      visited.add(cursor);
      const row: { parentKeyResultId: string | null; parentKeyResult: { objectiveId: string } | null } | null =
        await tx.objective.findUnique({
          where: { id: cursor },
          select: { parentKeyResultId: true, parentKeyResult: { select: { objectiveId: true } } },
        });
      if (row?.parentKeyResultId === keyResult.id) {
        throw new OKRHierarchyError("CIRCULAR_HIERARCHY", "This move would create an OKR hierarchy cycle.");
      }
      cursor = row?.parentKeyResult?.objectiveId ?? null;
    }
    if (cursor) {
      throw new OKRHierarchyError("CIRCULAR_HIERARCHY", "The OKR hierarchy exceeds the supported depth.");
    }

    const opportunities = await tx.opportunity.findMany({
      where: { linkedKeyResultId: keyResult.id, workspaceId: input.workspaceId },
      select: { id: true },
      take: MAX_MOVE_OPPORTUNITIES + 1,
    });
    if (opportunities.length > MAX_MOVE_OPPORTUNITIES) {
      throw new OKRHierarchyError(
        "INVALID_TIME_HORIZON",
        `This Key Result drives more than ${MAX_MOVE_OPPORTUNITIES} opportunities and cannot be moved in one step.`
      );
    }

    const last = await tx.keyResult.findFirst({
      where: { objectiveId: target.id },
      orderBy: { sortOrder: "desc" },
      select: { sortOrder: true },
    });
    const moved = await tx.keyResult.update({
      where: { id: keyResult.id },
      data: {
        objectiveId: target.id,
        sortOrder: (last?.sortOrder ?? -1) + 1,
        updatedAt: new Date(),
        ...(input.actorId ? { updatedById: input.actorId } : {}),
      },
    });

    // The Opportunity <-> Objective LEGACY link is derived from the pointer's Key Result, so it follows the move.
    for (const opportunity of opportunities) {
      await syncLegacyLink(tx, {
        opportunityId: opportunity.id,
        workspaceId: input.workspaceId,
        keyResultId: keyResult.id,
        ctx: { source: "UI", createdById: input.actorId ?? null },
      });
    }
    return { keyResult: moved, fromObjectiveId: keyResult.objectiveId, toObjectiveId: target.id };
  });
}
