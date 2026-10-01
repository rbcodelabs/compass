import getPrisma from "@/lib/db";
import { NO_CYCLE_LABEL } from "@/lib/okr-cycle-scope";

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
        a.keyResultSortOrder - b.keyResultSortOrder
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
