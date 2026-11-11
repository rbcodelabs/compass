/** Handler functions for OKR MCP tools. */

import getPrisma from "@/lib/db";
import { getEligibleParentKeyResults } from "@/lib/okr-hierarchy";
import { ok, fail } from "@/lib/mcp-output";
import { drainAfterParentDelete, drainKeyResultPointers, drainLegacyLinksForOpportunities, drainLinksFor } from "@/lib/typed-links";
import { drainTaskLinksTo } from "@/lib/task-link-writes";
import { readEntityLinksOpportunityKeyResultPointer } from "@/lib/links/readers";

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
  // The objective is deleted FIRST and its links drained AFTER (see drainAfterParentDelete): a refused or failed delete has touched no
  // link. The drain runs in committed passes of at most 500 links, so it can never exceed DSQL's 3,000-row cap however many it holds.
  const outcome = await prisma.$transaction(async (tx) => {
    const existing = await tx.objective.findUnique({
      where: { id: objectiveId },
      select: { id: true, title: true, _count: { select: { keyResults: true } } },
    });
    if (!existing) return { kind: "missing" as const };
    if (existing._count.keyResults > 0) {
      return { kind: "has-children" as const, existing };
    }
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

  // No foreign keys reach the typed link tables, so the links to the deleted objective are removed explicitly, after the delete.
  await drainAfterParentDelete("mcp.deleteObjective", () => drainLinksFor(prisma, "objective", [objectiveId]));
  // Task links to this objective live only in entity_links; they go now that the objective is gone.
  await drainAfterParentDelete("mcp.deleteObjective.taskLinks", () => drainTaskLinksTo(prisma, { linkedType: "OBJECTIVE", linkedIds: [objectiveId] }));

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
    select: { id: true, title: true, objectiveId: true, objective: { select: { workspaceId: true } } },
  });
  if (!existing) return fail(`Key Result "${keyResultId}" not found.`);

  // Read BEFORE the delete: these opportunities point at the key result, and their LEGACY objective links are the ones it implied.
  // Nothing is deleted here; the links are drained AFTER the key result is gone (see drainAfterParentDelete).
  const pointing = existing.objective.workspaceId
    ? (await readEntityLinksOpportunityKeyResultPointer(prisma, existing.objective.workspaceId, { keyResultIds: [keyResultId] })).map((link) => ({ id: link.fromId }))
    : [];

  const counts = await prisma.$transaction(async (tx) => {
    const updatedAt = new Date();
    // The pointer links themselves are drained after the delete; here the pointing opportunities are only touched (recency sort).
    const opportunities = pointing.length
      ? await tx.opportunity.updateMany({ where: { id: { in: pointing.map((o) => o.id) } }, data: { updatedAt } })
      : { count: 0 };
    const objectives = await tx.objective.updateMany({
      where: { parentKeyResultId: keyResultId },
      data: { parentKeyResultId: null, updatedAt },
    });
    const roadmapItems = await tx.roadmapItem.updateMany({
      where: { keyResultId },
      data: { keyResultId: null, updatedAt },
    });
    const customFieldValues = await tx.customFieldValue.deleteMany({
      where: { objectId: keyResultId, field: { objectType: "KEY_RESULT" } },
    });
    const canvasPositions = await tx.canvasNodePosition.deleteMany({
      where: { entityType: "KEY_RESULT", entityId: keyResultId },
    });
    const checkIns = await tx.checkIn.deleteMany({ where: { keyResultId } });
    await tx.keyResult.delete({ where: { id: keyResultId } });
    return { opportunities, objectives, roadmapItems, customFieldValues, canvasPositions, checkIns };
  });

  // Explicit link cleanup (no FKs), after the key result is gone: the LEGACY links from the opportunities that pointed at it to its
  // objective (DIRECT links are the user's own, objective-level, and stay), the pointer links themselves, the task links, and last
  // every remaining link to this key result (the solution links). Each is drained on its own so the reported counts stay separate.
  const legacy = await drainAfterParentDelete("mcp.deleteKeyResult.legacy", () => drainLegacyLinksForOpportunities(prisma, pointing.map((o) => o.id), existing.objectiveId));
  await drainAfterParentDelete("mcp.deleteKeyResult.pointers", () => drainKeyResultPointers(prisma, keyResultId));
  const taskLinks = await drainAfterParentDelete("mcp.deleteKeyResult.taskLinks", () => drainTaskLinksTo(prisma, { linkedType: "KEY_RESULT", linkedIds: [keyResultId] }));
  const solution = await drainAfterParentDelete("mcp.deleteKeyResult.solution", () => drainLinksFor(prisma, "keyResult", [keyResultId]));

  const data = {
    id: existing.id,
    deleted: true,
    unlinkedOpportunities: counts.opportunities.count,
    unlinkedObjectives: counts.objectives.count,
    unlinkedRoadmapItems: counts.roadmapItems.count,
    removedTaskLinks: taskLinks.removed,
    deletedCustomFieldValues: counts.customFieldValues.count,
    deletedCanvasPositions: counts.canvasPositions.count,
    deletedCheckIns: counts.checkIns.count,
    removedOpportunityLinks: legacy.removed,
    removedSolutionLinks: solution.removed,
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
  cycleId?: string;
}) {
  const options = await getEligibleParentKeyResults(workspaceId, cycleId ?? null);
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
