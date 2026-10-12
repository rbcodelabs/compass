import getPrisma from "@/lib/db"
import type { EntityLinkType } from "@/lib/entity-links"
import type { ResolvedLabels } from "@/lib/thinking-model/labels"

/**
 * The few fields a link card shows for one entity. Deliberately thin: a card in
 * a chat transcript needs a title and a glance at state, not the full detail
 * payload lib/entity-detail.ts builds for the panel (comments, evidence, links…).
 */
export type EntitySummary = {
  type: EntityLinkType
  id: string
  title: string
  /** Human label for the entity type, honouring the workspace's thinking-model renames. */
  typeLabel: string
  status: string | null
  /** One short secondary line (horizon, parent, progress…). */
  meta: string | null
  description: string | null
}

const DESCRIPTION_LIMIT = 220

function clip(text: string | null | undefined): string | null {
  const flat = text?.replace(/\s+/g, " ").trim()
  if (!flat) return null
  return flat.length > DESCRIPTION_LIMIT ? `${flat.slice(0, DESCRIPTION_LIMIT - 1).trimEnd()}…` : flat
}

function join(...parts: Array<string | null | undefined>): string | null {
  const kept = parts.filter((p): p is string => Boolean(p))
  return kept.length ? kept.join(" · ") : null
}

/**
 * Load one entity's card summary, scoped to `workspaceId`. Returns null when the
 * entity does not exist or lives in another workspace — the same "both look like
 * 404" contract as getEntityDetail, so a card never confirms a foreign row.
 *
 * `id` must already be a UUID (callers check `isEntityId`); every type here is
 * read through a workspace-filtered `findFirst`.
 */
export async function getEntitySummary(
  type: EntityLinkType,
  id: string,
  workspaceId: string,
  labels: ResolvedLabels,
): Promise<EntitySummary | null> {
  const prisma = getPrisma()
  const base = (typeLabel: string, row: { id: string; title: string }) => ({ type, id: row.id, title: row.title, typeLabel })

  switch (type) {
    case "objective": {
      const r = await prisma.objective.findFirst({ where: { id, workspaceId }, select: { id: true, title: true, status: true, description: true } })
      return r && { ...base(labels.objective.singular, r), status: r.status, meta: null, description: clip(r.description) }
    }
    case "keyResult": {
      const r = await prisma.keyResult.findFirst({
        where: { id, objective: { workspaceId } },
        select: { id: true, title: true, target: true, current: true, unit: true, objective: { select: { title: true } } },
      })
      return r && {
        ...base(labels.keyResult.singular, r),
        status: null,
        meta: join(`${r.current} / ${r.target}${r.unit ? ` ${r.unit}` : ""}`, r.objective.title),
        description: null,
      }
    }
    case "opportunity": {
      const r = await prisma.opportunity.findFirst({ where: { id, workspaceId }, select: { id: true, title: true, status: true, description: true } })
      return r && { ...base(labels.opportunity.singular, r), status: r.status, meta: null, description: clip(r.description) }
    }
    case "solution": {
      const r = await prisma.solution.findFirst({
        where: { id, workspaceId },
        select: { id: true, title: true, status: true, description: true, opportunity: { select: { title: true } } },
      })
      return r && { ...base(labels.solution.singular, r), status: r.status, meta: r.opportunity.title, description: clip(r.description) }
    }
    case "assumption": {
      const r = await prisma.assumption.findFirst({
        where: { id, solution: { workspaceId } },
        select: { id: true, title: true, status: true, description: true, solution: { select: { title: true } } },
      })
      return r && { ...base("Assumption", r), status: r.status, meta: r.solution.title, description: clip(r.description) }
    }
    case "experiment": {
      const r = await prisma.experiment.findFirst({ where: { id, workspaceId }, select: { id: true, title: true, status: true, hypothesis: true } })
      return r && { ...base("Experiment", r), status: r.status, meta: null, description: clip(r.hypothesis) }
    }
    case "roadmapItem": {
      const r = await prisma.roadmapItem.findFirst({ where: { id, workspaceId }, select: { id: true, title: true, status: true, horizon: true, description: true } })
      return r && { ...base("Roadmap item", r), status: r.status, meta: r.horizon, description: clip(r.description) }
    }
    case "feedback": {
      const r = await prisma.feedbackItem.findFirst({ where: { id, workspaceId }, select: { id: true, title: true, status: true, type: true, description: true } })
      return r && { ...base("Feedback", r), status: r.status, meta: r.type, description: clip(r.description) }
    }
    case "task": {
      const r = await prisma.task.findFirst({ where: { id, workspaceId }, select: { id: true, title: true, status: true, priority: true, dueDate: true, description: true } })
      return r && {
        ...base("Task", r),
        status: r.status,
        meta: join(r.priority, r.dueDate ? `Due ${r.dueDate.toISOString().slice(0, 10)}` : null),
        description: clip(r.description),
      }
    }
    case "doc": {
      const r = await prisma.doc.findFirst({ where: { id, workspaceId }, select: { id: true, title: true, docType: true } })
      return r && { ...base("Doc", r), status: null, meta: r.docType === "STANDARD" ? null : r.docType, description: null }
    }
    case "artifact": {
      const r = await prisma.artifact.findFirst({ where: { id, workspaceId }, select: { id: true, title: true, status: true, kind: true, description: true } })
      return r && { ...base("Artifact", r), status: r.status, meta: r.kind, description: clip(r.description) }
    }
  }
}
