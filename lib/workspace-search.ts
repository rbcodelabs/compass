import getPrisma from "@/lib/db"
import { searchHelp } from "@/lib/docs"

export const WORKSPACE_SEARCH_GROUPS = [
  { type: "opportunity", label: "Opportunities" },
  { type: "solution", label: "Solutions" },
  { type: "experiment", label: "Experiments" },
  { type: "roadmapItem", label: "Roadmap" },
  { type: "task", label: "Tasks" },
  { type: "feedback", label: "Feedback" },
  { type: "doc", label: "Docs" },
  { type: "help", label: "Help" },
] as const

export type WorkspaceSearchType = (typeof WORKSPACE_SEARCH_GROUPS)[number]["type"]

export type WorkspaceSearchItem = {
  type: WorkspaceSearchType
  id: string
  title: string
  context?: string
  href: string
}

export type WorkspaceSearchGroup = {
  type: WorkspaceSearchType
  label: string
  items: WorkspaceSearchItem[]
}

export type WorkspaceSearchResponse = {
  query: string
  groups: WorkspaceSearchGroup[]
}

export type NormalizedWorkspaceSearchQuery =
  | { ok: true; query: string }
  | { ok: false; reason: "too_short" | "too_long" }

export function normalizeWorkspaceSearchQuery(raw: string): NormalizedWorkspaceSearchQuery {
  const query = raw.trim()
  if (query.length < 2) return { ok: false, reason: "too_short" }
  if (query.length > 100) return { ok: false, reason: "too_long" }
  return { ok: true, query }
}

function context(...parts: Array<string | null | undefined>): string | undefined {
  const visible = parts.filter((part): part is string => Boolean(part))
  return visible.length ? visible.join(" · ") : undefined
}

export async function searchWorkspace(input: {
  workspaceId: string
  orgSlug: string
  workspaceSlug: string
  query: string
}): Promise<WorkspaceSearchResponse> {
  const prisma = getPrisma()
  const titleFilter = { contains: input.query, mode: "insensitive" as const }
  const directWhere = { workspaceId: input.workspaceId, title: titleFilter }
  const queryOptions = { take: 5, orderBy: [{ title: "asc" as const }, { id: "asc" as const }] }

  const [opportunities, solutions, experiments, roadmapItems, tasks, feedback, docs] =
    await Promise.all([
      prisma.opportunity.findMany({ ...queryOptions, where: directWhere, select: { id: true, title: true, status: true } }),
      prisma.solution.findMany({
        ...queryOptions,
        where: { opportunity: { workspaceId: input.workspaceId }, title: titleFilter },
        select: { id: true, title: true, status: true, opportunity: { select: { id: true, title: true } } },
      }),
      prisma.experiment.findMany({ ...queryOptions, where: directWhere, select: { id: true, title: true, status: true, conclusion: true } }),
      prisma.roadmapItem.findMany({ ...queryOptions, where: directWhere, select: { id: true, title: true, horizon: true, status: true } }),
      prisma.task.findMany({ ...queryOptions, where: directWhere, select: { id: true, title: true, status: true, priority: true } }),
      prisma.feedbackItem.findMany({ ...queryOptions, where: directWhere, select: { id: true, title: true, type: true, status: true } }),
      prisma.doc.findMany({ ...queryOptions, where: directWhere, select: { id: true, title: true, docType: true } }),
    ])

  const helpResults = searchHelp(input.query, 5)

  const base = `/${encodeURIComponent(input.orgSlug)}/${encodeURIComponent(input.workspaceSlug)}`
  const detailHref = (path: string, type: string, id: string) =>
    `${base}/${path}?detail=${encodeURIComponent(`${type}:${id}`)}`

  return {
    query: input.query,
    groups: [
      { type: "opportunity", label: "Opportunities", items: opportunities.map((item) => ({ type: "opportunity", id: item.id, title: item.title, context: item.status, href: `${base}/discovery/${item.id}` })) },
      { type: "solution", label: "Solutions", items: solutions.map((item) => ({ type: "solution", id: item.id, title: item.title, context: context(item.status, item.opportunity.title), href: detailHref(`discovery/${item.opportunity.id}`, "solution", item.id) })) },
      { type: "experiment", label: "Experiments", items: experiments.map((item) => ({ type: "experiment", id: item.id, title: item.title, context: context(item.status, item.conclusion), href: `${base}/experiments/${item.id}` })) },
      { type: "roadmapItem", label: "Roadmap", items: roadmapItems.map((item) => ({ type: "roadmapItem", id: item.id, title: item.title, context: context(item.horizon, item.status), href: detailHref("roadmap", "roadmapItem", item.id) })) },
      { type: "task", label: "Tasks", items: tasks.map((item) => ({ type: "task", id: item.id, title: item.title, context: context(item.status, item.priority), href: `${base}/tasks/${item.id}` })) },
      { type: "feedback", label: "Feedback", items: feedback.map((item) => ({ type: "feedback", id: item.id, title: item.title, context: context(item.type, item.status), href: detailHref("feedback", "feedback", item.id) })) },
      { type: "doc", label: "Docs", items: docs.map((item) => ({ type: "doc", id: item.id, title: item.title, context: item.docType, href: `${base}/docs/${item.id}` })) },
      {
        type: "help",
        label: "Help",
        items: helpResults.map((item) => ({
          type: "help",
          id: `${item.slug}:${item.anchor ?? "root"}`,
          title: item.title,
          context: context(item.heading ?? item.section),
          href: `/help/${item.slug}${item.anchor ? "#" + item.anchor : ""}`,
        })),
      },
    ],
  }
}
