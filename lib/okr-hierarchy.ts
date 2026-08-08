import getPrisma from "@/lib/db";

export type ParentKeyResultOption = {
  id: string;
  title: string;
  objectiveId: string;
  objectiveTitle: string;
  cycleId: string;
  cycleTitle: string;
  cycleStatus: string;
  cycleStartDate: Date;
  cycleEndDate: Date;
};

export type SupportingObjectiveOption = {
  id: string;
  title: string;
  cycleId: string;
  cycleTitle: string;
  cycleStartDate: Date;
  cycleEndDate: Date;
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

/**
 * Return KRs from longer-horizon cycles that fully contain the child cycle.
 * Cycle dates, rather than title conventions, make this work for calendar
 * years, fiscal years, quarters, months, and custom planning periods.
 */
export async function getEligibleParentKeyResults(
  workspaceId: string,
  childCycleId: string
): Promise<ParentKeyResultOption[]> {
  const prisma = getPrisma();
  const childCycle = await prisma.oKRCycle.findFirst({
    where: { id: childCycleId, workspaceId },
    select: { id: true, startDate: true, endDate: true },
  });

  if (!childCycle) return [];

  const keyResults = await prisma.keyResult.findMany({
    where: {
      objective: {
        cycle: {
          workspaceId,
          id: { not: childCycle.id },
          status: { in: ["DRAFT", "ACTIVE"] },
          startDate: { lte: childCycle.startDate },
          endDate: { gte: childCycle.endDate },
        },
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
      (kr) =>
        kr.objective.cycle.startDate.getTime() !== childCycle.startDate.getTime() ||
        kr.objective.cycle.endDate.getTime() !== childCycle.endDate.getTime()
    )
    .map((kr) => ({
      id: kr.id,
      title: kr.title,
      objectiveId: kr.objective.id,
      objectiveTitle: kr.objective.title,
      cycleId: kr.objective.cycle.id,
      cycleTitle: kr.objective.cycle.title,
      cycleStatus: kr.objective.cycle.status,
      cycleStartDate: kr.objective.cycle.startDate,
      cycleEndDate: kr.objective.cycle.endDate,
      objectiveSortOrder: kr.objective.sortOrder,
      keyResultSortOrder: kr.sortOrder,
    }))
    .sort((a, b) => {
      const status = Number(b.cycleStatus === "ACTIVE") - Number(a.cycleStatus === "ACTIVE");
      if (status !== 0) return status;
      const aSpan = a.cycleEndDate.getTime() - a.cycleStartDate.getTime();
      const bSpan = b.cycleEndDate.getTime() - b.cycleStartDate.getTime();
      return (
        aSpan - bSpan ||
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

/** Return unlinked Objectives in strictly shorter cycles contained by a parent cycle. */
export async function getEligibleSupportingObjectives(
  workspaceId: string,
  parentCycleId: string
): Promise<SupportingObjectiveOption[]> {
  const prisma = getPrisma();
  const parentCycle = await prisma.oKRCycle.findFirst({
    where: { id: parentCycleId, workspaceId },
    select: { id: true, status: true, startDate: true, endDate: true },
  });

  if (!parentCycle || parentCycle.status === "CLOSED") return [];

  const objectives = await prisma.objective.findMany({
    where: {
      parentKeyResultId: null,
      cycle: {
        workspaceId,
        id: { not: parentCycle.id },
        startDate: { gte: parentCycle.startDate },
        endDate: { lte: parentCycle.endDate },
      },
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
      (objective) =>
        objective.cycle.startDate.getTime() !== parentCycle.startDate.getTime() ||
        objective.cycle.endDate.getTime() !== parentCycle.endDate.getTime()
    )
    .map((objective) => ({
      id: objective.id,
      title: objective.title,
      cycleId: objective.cycle.id,
      cycleTitle: objective.cycle.title,
      cycleStartDate: objective.cycle.startDate,
      cycleEndDate: objective.cycle.endDate,
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
    where: { id: input.objectiveId, cycle: { workspaceId: input.workspaceId } },
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
      objective: { cycle: { workspaceId: input.workspaceId } },
    },
    include: { objective: { include: { cycle: true } } },
  });

  if (!parent) {
    throw new OKRHierarchyError("KEY_RESULT_NOT_FOUND", "Key Result not found in this workspace.");
  }
  if (parent.objectiveId === child.id) {
    throw new OKRHierarchyError("SAME_OBJECTIVE", "An Objective cannot support one of its own Key Results.");
  }
  if (parent.objective.cycle.status === "CLOSED") {
    throw new OKRHierarchyError("CLOSED_PARENT_CYCLE", "A closed cycle cannot receive new supporting Objectives.");
  }

  const containsChild =
    parent.objective.cycle.startDate <= child.cycle.startDate &&
    parent.objective.cycle.endDate >= child.cycle.endDate;
  const isLongerHorizon =
    parent.objective.cycle.startDate < child.cycle.startDate ||
    parent.objective.cycle.endDate > child.cycle.endDate;
  if (!containsChild || !isLongerHorizon) {
    throw new OKRHierarchyError(
      "INVALID_TIME_HORIZON",
      "The parent KR must belong to a longer cycle that fully contains this Objective's cycle."
    );
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
