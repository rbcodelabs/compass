/** Handler functions for OKR MCP tools. */

import getPrisma from "@/lib/db";
import { getEligibleParentKeyResults } from "@/lib/okr-hierarchy";
import { ok, fail } from "@/lib/mcp-output";

type ObjectiveStatus = "ON_TRACK" | "AT_RISK" | "OFF_TRACK" | "COMPLETE";

export async function updateObjective({
  objectiveId,
  title,
  description,
  status,
}: {
  objectiveId: string;
  title?: string;
  description?: string | null;
  status?: ObjectiveStatus;
}) {
  const prisma = getPrisma();
  const existing = await prisma.objective.findUnique({
    where: { id: objectiveId },
    select: { id: true },
  });
  if (!existing) return fail(`Objective "${objectiveId}" not found.`);

  const data: {
    updatedAt: Date;
    title?: string;
    description?: string | null;
    status?: ObjectiveStatus;
  } = { updatedAt: new Date() };
  if (title !== undefined) data.title = title.trim();
  if (description !== undefined) data.description = description === null ? null : description.trim();
  if (status !== undefined) data.status = status;

  const updated = await prisma.objective.update({ where: { id: objectiveId }, data });
  return ok(
    `**Objective updated**\nID: ${updated.id}\nTitle: ${updated.title}\nStatus: ${updated.status}`,
    {
      id: updated.id,
      title: updated.title,
      description: updated.description,
      status: updated.status,
    },
  );
}

export async function deleteObjective({ objectiveId }: { objectiveId: string }) {
  const prisma = getPrisma();
  const outcome = await prisma.$transaction(async (tx) => {
    const existing = await tx.objective.findUnique({
      where: { id: objectiveId },
      select: { id: true, title: true, _count: { select: { keyResults: true } } },
    });
    if (!existing) return { kind: "missing" as const };
    if (existing._count.keyResults > 0) {
      return { kind: "has-children" as const, existing };
    }
    await tx.taskLink.deleteMany({
      where: { linkedType: "OBJECTIVE", linkedId: objectiveId },
    });
    await tx.customFieldValue.deleteMany({
      where: { objectId: objectiveId, field: { objectType: "OBJECTIVE" } },
    });
    await tx.canvasNodePosition.deleteMany({
      where: { entityType: "OBJECTIVE", entityId: objectiveId },
    });
    await tx.objective.delete({ where: { id: objectiveId } });
    return { kind: "deleted" as const, existing };
  });
  if (outcome.kind === "missing") return fail(`Objective "${objectiveId}" not found.`);
  if (outcome.kind === "has-children") {
    return fail(
      `Objective "${outcome.existing.title}" has ${outcome.existing._count.keyResults} child Key Results. Delete those Key Results before deleting the Objective.`,
    );
  }

  return ok(`**Objective deleted**\nID: ${outcome.existing.id}\nTitle: ${outcome.existing.title}`, {
    id: outcome.existing.id,
    deleted: true,
  });
}

export async function updateKeyResult({
  keyResultId,
  title,
  target,
  unit,
  current,
}: {
  keyResultId: string;
  title?: string;
  target?: number;
  unit?: string | null;
  current?: number;
}) {
  const prisma = getPrisma();
  const existing = await prisma.keyResult.findUnique({
    where: { id: keyResultId },
    select: { id: true },
  });
  if (!existing) return fail(`Key Result "${keyResultId}" not found.`);

  const data: {
    updatedAt: Date;
    title?: string;
    target?: number;
    unit?: string | null;
    current?: number;
  } = { updatedAt: new Date() };
  if (title !== undefined) data.title = title.trim();
  if (target !== undefined) data.target = target;
  if (unit !== undefined) data.unit = unit === null ? null : unit.trim();
  if (current !== undefined) data.current = current;

  const updated = await prisma.keyResult.update({ where: { id: keyResultId }, data });
  return ok(
    `**Key Result updated**\nID: ${updated.id}\nTitle: ${updated.title}\nTarget: ${updated.target}${updated.unit ? ` ${updated.unit}` : ""}\nCurrent: ${updated.current}`,
    {
      id: updated.id,
      title: updated.title,
      target: updated.target,
      unit: updated.unit,
      current: updated.current,
    },
  );
}

export async function deleteKeyResult({ keyResultId }: { keyResultId: string }) {
  const prisma = getPrisma();
  const existing = await prisma.keyResult.findUnique({
    where: { id: keyResultId },
    select: { id: true, title: true },
  });
  if (!existing) return fail(`Key Result "${keyResultId}" not found.`);

  const counts = await prisma.$transaction(async (tx) => {
    const updatedAt = new Date();
    const opportunities = await tx.opportunity.updateMany({
      where: { linkedKeyResultId: keyResultId },
      data: { linkedKeyResultId: null, updatedAt },
    });
    const objectives = await tx.objective.updateMany({
      where: { parentKeyResultId: keyResultId },
      data: { parentKeyResultId: null, updatedAt },
    });
    const roadmapItems = await tx.roadmapItem.updateMany({
      where: { keyResultId },
      data: { keyResultId: null, updatedAt },
    });
    const taskLinks = await tx.taskLink.deleteMany({
      where: { linkedType: "KEY_RESULT", linkedId: keyResultId },
    });
    const customFieldValues = await tx.customFieldValue.deleteMany({
      where: { objectId: keyResultId, field: { objectType: "KEY_RESULT" } },
    });
    const canvasPositions = await tx.canvasNodePosition.deleteMany({
      where: { entityType: "KEY_RESULT", entityId: keyResultId },
    });
    const checkIns = await tx.checkIn.deleteMany({ where: { keyResultId } });
    await tx.keyResult.delete({ where: { id: keyResultId } });
    return { opportunities, objectives, roadmapItems, taskLinks, customFieldValues, canvasPositions, checkIns };
  });

  const data = {
    id: existing.id,
    deleted: true,
    unlinkedOpportunities: counts.opportunities.count,
    unlinkedObjectives: counts.objectives.count,
    unlinkedRoadmapItems: counts.roadmapItems.count,
    removedTaskLinks: counts.taskLinks.count,
    deletedCustomFieldValues: counts.customFieldValues.count,
    deletedCanvasPositions: counts.canvasPositions.count,
    deletedCheckIns: counts.checkIns.count,
  };
  return ok(
    `**Key Result deleted**\nID: ${existing.id}\nTitle: ${existing.title}\nUnlinked references: ${data.unlinkedOpportunities} opportunities, ${data.unlinkedObjectives} objectives, ${data.unlinkedRoadmapItems} roadmap items\nDeleted CheckIns: ${data.deletedCheckIns}`,
    data,
  );
}

export async function listEligibleParentKeyResults({
  workspaceId,
  cycleId,
}: {
  workspaceId: string;
  cycleId: string;
}) {
  const options = await getEligibleParentKeyResults(workspaceId, cycleId);
  const text = options.length
    ? options
        .map((kr) => `${kr.cycleTitle} / ${kr.objectiveTitle} / ${kr.title}\nID: ${kr.id}`)
        .join("\n\n")
    : "No eligible higher-level Key Results found.";
  return options.length
    ? ok(text, {
        items: options.map((kr) => ({
          id: kr.id,
          cycleTitle: kr.cycleTitle,
          objectiveTitle: kr.objectiveTitle,
          title: kr.title,
        })),
        count: options.length,
      })
    : fail(text);
}
