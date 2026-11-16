import getPrisma, { type AppPrismaClient } from "@/lib/db"
import { plainTextOf } from "@/lib/comment-mentions"
import { cycleRouteSegment } from "@/lib/okr-cycle-scope"
import { displayIdFromRow } from "@/lib/work-item-ids"

export type ResolvedCommentLink = {
  commentId: string
  rootCommentId: string
  targetType: string
  targetId: string
  /** Human-readable label for a COMMENT task origin link. */
  title: string
  /** Workspace-relative path (no leading `/{org}/{ws}/`) that opens the parent target and focuses this comment, or null when missing. */
  workspaceRelativePath: string | null
}

type TargetMeta = {
  /** Display ID like `OPP-7`, or `“Truncated title”` when unnumbered. */
  label: string
  /** Workspace-relative path to the parent object (before appending `comment=<id>`). */
  basePath: string
}

const EXCERPT_MAX = 60
const TITLE_FALLBACK_MAX = 36

function truncate(value: string, max: number): string {
  const clean = value.replace(/\s+/g, " ").trim()
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean
}

function formatCommentExcerpt(body: string | null | undefined): string {
  if (!body) return ""
  const withoutMentions = plainTextOf(body)
  const withoutMarkdownLinks = withoutMentions.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
  return truncate(withoutMarkdownLinks, EXCERPT_MAX)
}

function labelForTarget(displayId: string | null, rawTitle: string | null | undefined, fallbackNoun: string): string {
  if (displayId) return displayId
  const trimmed = rawTitle?.replace(/\s+/g, " ").trim()
  return trimmed ? `“${truncate(trimmed, TITLE_FALLBACK_MAX)}”` : fallbackNoun
}

function appendCommentParam(basePath: string, commentId: string): string {
  const sep = basePath.includes("?") ? "&" : "?"
  return `${basePath}${sep}comment=${encodeURIComponent(commentId)}`
}

function targetNoun(targetType: string): string {
  return targetType === "REVIEW_REQUEST" ? "decision" : targetType.toLowerCase().replace(/_/g, " ")
}

async function resolveTargetsByType(
  prisma: AppPrismaClient,
  workspaceId: string,
  targetType: string,
  ids: string[],
): Promise<Map<string, TargetMeta>> {
  const out = new Map<string, TargetMeta>()
  if (ids.length === 0) return out
  const uniqueIds = [...new Set(ids)]

  switch (targetType) {
    case "OPPORTUNITY": {
      const rows = (await prisma.opportunity?.findMany({
        where: { id: { in: uniqueIds }, workspaceId },
        select: { id: true, title: true, seqPrefix: true, seqNumber: true },
      })) ?? []
      for (const r of rows) {
        const displayId = displayIdFromRow("opportunity", r)
        const ref = encodeURIComponent(displayId ?? r.id)
        out.set(r.id, { label: labelForTarget(displayId, r.title, "opportunity"), basePath: `discovery/${ref}` })
      }
      break
    }
    case "SOLUTION": {
      const rows = (await prisma.solution?.findMany({
        where: { id: { in: uniqueIds }, workspaceId },
        select: {
          id: true,
          title: true,
          opportunityId: true,
          seqPrefix: true,
          seqNumber: true,
          opportunity: { select: { seqPrefix: true, seqNumber: true } },
        },
      })) ?? []
      for (const r of rows) {
        const displayId = displayIdFromRow("solution", r)
        const oppDisplayId = r.opportunity ? displayIdFromRow("opportunity", r.opportunity) : null
        const oppRef = encodeURIComponent(oppDisplayId ?? r.opportunityId)
        const solRef = displayId ?? r.id
        out.set(r.id, {
          label: labelForTarget(displayId, r.title, "solution"),
          basePath: `discovery/${oppRef}?detail=${encodeURIComponent(`solution:${solRef}`)}`,
        })
      }
      break
    }
    case "ASSUMPTION": {
      const rows = (await prisma.assumption?.findMany({
        where: { id: { in: uniqueIds }, solution: { workspaceId } },
        select: {
          id: true,
          title: true,
          seqPrefix: true,
          seqNumber: true,
          solution: { select: { opportunityId: true, opportunity: { select: { seqPrefix: true, seqNumber: true } } } },
        },
      })) ?? []
      for (const r of rows) {
        const displayId = displayIdFromRow("assumption", r)
        const oppDisplayId = r.solution?.opportunity ? displayIdFromRow("opportunity", r.solution.opportunity) : null
        const oppRef = encodeURIComponent(oppDisplayId ?? r.solution.opportunityId)
        const asmRef = displayId ?? r.id
        out.set(r.id, {
          label: labelForTarget(displayId, r.title, "assumption"),
          basePath: `discovery/${oppRef}?detail=${encodeURIComponent(`assumption:${asmRef}`)}`,
        })
      }
      break
    }
    case "EXPERIMENT": {
      const rows = (await prisma.experiment?.findMany({
        where: { id: { in: uniqueIds }, workspaceId },
        select: { id: true, title: true, seqPrefix: true, seqNumber: true },
      })) ?? []
      for (const r of rows) {
        const displayId = displayIdFromRow("experiment", r)
        const ref = encodeURIComponent(displayId ?? r.id)
        out.set(r.id, { label: labelForTarget(displayId, r.title, "experiment"), basePath: `experiments/${ref}` })
      }
      break
    }
    case "ROADMAP_ITEM": {
      const rows = (await prisma.roadmapItem?.findMany({
        where: { id: { in: uniqueIds }, workspaceId },
        select: { id: true, title: true, seqPrefix: true, seqNumber: true },
      })) ?? []
      for (const r of rows) {
        const displayId = displayIdFromRow("roadmapItem", r)
        const ref = displayId ?? r.id
        out.set(r.id, {
          label: labelForTarget(displayId, r.title, "roadmap item"),
          basePath: `roadmap?detail=${encodeURIComponent(`roadmapItem:${ref}`)}`,
        })
      }
      break
    }
    case "OBJECTIVE": {
      const rows = (await prisma.objective?.findMany({
        where: { id: { in: uniqueIds }, workspaceId },
        select: { id: true, title: true, cycleId: true, seqPrefix: true, seqNumber: true },
      })) ?? []
      for (const r of rows) {
        const displayId = displayIdFromRow("objective", r)
        const ref = displayId ?? r.id
        out.set(r.id, {
          label: labelForTarget(displayId, r.title, "objective"),
          basePath: `okrs/${cycleRouteSegment(r.cycleId)}?detail=${encodeURIComponent(`objective:${ref}`)}`,
        })
      }
      break
    }
    case "KEY_RESULT": {
      const rows = (await prisma.keyResult?.findMany({
        where: { id: { in: uniqueIds }, objective: { workspaceId } },
        select: { id: true, title: true, seqPrefix: true, seqNumber: true, objective: { select: { cycleId: true } } },
      })) ?? []
      for (const r of rows) {
        const displayId = displayIdFromRow("keyResult", r)
        const ref = displayId ?? r.id
        out.set(r.id, {
          label: labelForTarget(displayId, r.title, "key result"),
          basePath: `okrs/${cycleRouteSegment(r.objective.cycleId)}?detail=${encodeURIComponent(`keyResult:${ref}`)}`,
        })
      }
      break
    }
    case "FEEDBACK_ITEM": {
      const rows = (await prisma.feedbackItem?.findMany({
        where: { id: { in: uniqueIds }, workspaceId },
        select: { id: true, title: true, seqPrefix: true, seqNumber: true },
      })) ?? []
      for (const r of rows) {
        const displayId = displayIdFromRow("feedback", r)
        const ref = displayId ?? r.id
        out.set(r.id, {
          label: labelForTarget(displayId, r.title, "feedback"),
          basePath: `feedback?detail=${encodeURIComponent(`feedback:${ref}`)}`,
        })
      }
      break
    }
    case "TASK": {
      const rows = (await prisma.task?.findMany({
        where: { id: { in: uniqueIds }, workspaceId },
        select: { id: true, title: true, seqPrefix: true, seqNumber: true },
      })) ?? []
      for (const r of rows) {
        const displayId = displayIdFromRow("task", r)
        const ref = encodeURIComponent(displayId ?? r.id)
        out.set(r.id, { label: labelForTarget(displayId, r.title, "task"), basePath: `tasks/${ref}` })
      }
      break
    }
    case "DOC": {
      const rows = (await prisma.doc?.findMany({
        where: { id: { in: uniqueIds }, workspaceId },
        select: { id: true, title: true, seqPrefix: true, seqNumber: true },
      })) ?? []
      for (const r of rows) {
        const displayId = displayIdFromRow("doc", r)
        const ref = encodeURIComponent(displayId ?? r.id)
        out.set(r.id, { label: labelForTarget(displayId, r.title, "doc"), basePath: `docs/${ref}` })
      }
      break
    }
    case "ARTIFACT": {
      const rows = (await prisma.artifact?.findMany({
        where: { id: { in: uniqueIds }, workspaceId },
        select: { id: true, title: true, seqPrefix: true, seqNumber: true },
      })) ?? []
      for (const r of rows) {
        const displayId = displayIdFromRow("artifact", r)
        const ref = encodeURIComponent(displayId ?? r.id)
        out.set(r.id, { label: labelForTarget(displayId, r.title, "artifact"), basePath: `docs/artifacts/${ref}` })
      }
      break
    }
    case "RESEARCH_STUDY": {
      const rows = (await prisma.researchStudy?.findMany({
        where: { id: { in: uniqueIds }, workspaceId },
        select: { id: true, name: true, seqPrefix: true, seqNumber: true },
      })) ?? []
      for (const r of rows) {
        const displayId = displayIdFromRow("researchStudy", r)
        const ref = encodeURIComponent(displayId ?? r.id)
        out.set(r.id, {
          label: labelForTarget(displayId, r.name, "research study"),
          basePath: `capture/studies/${ref}`,
        })
      }
      break
    }
    case "REVIEW_REQUEST": {
      const rows = (await prisma.reviewRequest?.findMany({
        where: { id: { in: uniqueIds }, workspaceId, gateType: "TRACKED_DECISION" },
        select: { id: true, seqPrefix: true, seqNumber: true, currentRevision: { select: { title: true } } },
      })) ?? []
      for (const r of rows) {
        const displayId = displayIdFromRow("reviewRequest", r)
        const ref = encodeURIComponent(displayId ?? r.id)
        out.set(r.id, {
          label: labelForTarget(displayId, r.currentRevision?.title, "decision"),
          basePath: `reviews/${ref}`,
        })
      }
      break
    }
  }

  return out
}

/**
 * Batch-resolves display titles and workspace-relative deep-link paths for COMMENT
 * task origin links (`TASK_CREATED_FROM`), keyed `COMMENT:<commentId>`.
 *
 * - Anchored Doc comments keep their quoted passage label (`Comment on “…”`) and
 *   deep-link to `docs/<docRef>?comment=<commentId>`.
 * - Non-Doc Discussion comments (and unanchored Doc comments) format with their
 *   parent object's display ID (or quoted title fallback) plus a cleaned comment
 *   excerpt (`Comment on OPP-7: "there is still a solution space…"`), deep-linking
 *   to the parent page/panel with `?comment=<commentId>`.
 */
export async function resolveCommentLinks(
  workspaceId: string,
  commentIds: string[],
): Promise<Map<string, ResolvedCommentLink>> {
  const resolved = new Map<string, ResolvedCommentLink>()
  if (commentIds.length === 0) return resolved

  const prisma = getPrisma()
  const rows = await prisma.comment.findMany({
    where: { id: { in: [...new Set(commentIds)] }, workspaceId },
    select: {
      id: true,
      parentId: true,
      targetType: true,
      targetId: true,
      body: true,
      docAnchor: { select: { anchorText: true } },
    },
  })
  if (rows.length === 0) return resolved

  const targetIdsByType = new Map<string, string[]>()
  for (const row of rows) {
    if (!row.targetType || !row.targetId) continue
    const list = targetIdsByType.get(row.targetType) ?? []
    list.push(row.targetId)
    targetIdsByType.set(row.targetType, list)
  }

  const metaByTargetKey = new Map<string, TargetMeta>()
  await Promise.all(
    Array.from(targetIdsByType.entries()).map(async ([targetType, ids]) => {
      const map = await resolveTargetsByType(prisma, workspaceId, targetType, ids)
      for (const [targetId, meta] of map) {
        metaByTargetKey.set(`${targetType}:${targetId}`, meta)
      }
    }),
  )

  for (const row of rows) {
    const meta = metaByTargetKey.get(`${row.targetType}:${row.targetId}`)
    const anchor = row.docAnchor?.anchorText?.replace(/\s+/g, " ").trim()
    const excerpt = formatCommentExcerpt(row.body)
    const parentLabel = meta?.label ?? targetNoun(row.targetType)

    let title: string
    if (anchor) {
      title = `Comment on “${truncate(anchor, EXCERPT_MAX)}”`
    } else if (excerpt) {
      title = `Comment on ${parentLabel}: "${excerpt}"`
    } else if (meta?.label) {
      title = `Comment on ${meta.label}`
    } else {
      title = row.targetType === "DOC" ? "Doc comment" : "Comment"
    }

    resolved.set(`COMMENT:${row.id}`, {
      commentId: row.id,
      rootCommentId: row.parentId ?? row.id,
      targetType: row.targetType,
      targetId: row.targetId,
      title,
      workspaceRelativePath: meta ? appendCommentParam(meta.basePath, row.id) : null,
    })
  }

  return resolved
}

/**
 * Display titles for TaskLinks of linkedType COMMENT, keyed `COMMENT:<commentId>`
 * to match the maps the task readers already build for other link types.
 */
export async function commentLinkTitles(workspaceId: string, commentIds: string[]): Promise<Map<string, string>> {
  const titles = new Map<string, string>()
  for (const [key, info] of await resolveCommentLinks(workspaceId, commentIds)) {
    titles.set(key, info.title)
  }
  return titles
}
