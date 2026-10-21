import getPrisma from "@/lib/db"
import { searchHelp } from "@/lib/docs"
import { entityPath, type EntityLinkType } from "@/lib/entity-links"
import { displayIdFromRow, parseDisplayId } from "@/lib/work-item-ids"

export const WORKSPACE_SEARCH_GROUPS = [
  { type: "opportunity", label: "Opportunities" },
  { type: "solution", label: "Solutions" },
  { type: "experiment", label: "Experiments" },
  { type: "roadmapItem", label: "Roadmap" },
  { type: "task", label: "Tasks" },
  { type: "feedback", label: "Feedback" },
  { type: "doc", label: "Docs" },
  { type: "help", label: "User Guide" },
] as const

export type WorkspaceSearchType = (typeof WORKSPACE_SEARCH_GROUPS)[number]["type"]

export type WorkspaceSearchItem = {
  type: WorkspaceSearchType
  id: string
  /** `TASK-12`; absent for help articles and for rows that are not numbered yet. */
  displayId?: string | null
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
  const seq = { seqPrefix: true, seqNumber: true } as const

  // One loader per searchable type, so the same select serves the title search and the exact-ID lookup.
  type Where = Record<string, unknown>
  type Options = { take: number; orderBy?: Array<Record<string, "asc">> }
  const loaders = {
    opportunity: (where: Where, o: Options) => prisma.opportunity.findMany({ ...o, where, select: { id: true, title: true, status: true, ...seq } }),
    solution: (where: Where, o: Options) => prisma.solution.findMany({ ...o, where, select: { id: true, title: true, status: true, ...seq, opportunity: { select: { id: true, title: true } } } }),
    experiment: (where: Where, o: Options) => prisma.experiment.findMany({ ...o, where, select: { id: true, title: true, status: true, conclusion: true, ...seq } }),
    roadmapItem: (where: Where, o: Options) => prisma.roadmapItem.findMany({ ...o, where, select: { id: true, title: true, horizon: true, status: true, ...seq } }),
    task: (where: Where, o: Options) => prisma.task.findMany({ ...o, where, select: { id: true, title: true, status: true, priority: true, ...seq } }),
    feedback: (where: Where, o: Options) => prisma.feedbackItem.findMany({ ...o, where, select: { id: true, title: true, type: true, status: true, ...seq } }),
    doc: (where: Where, o: Options) => prisma.doc.findMany({ ...o, where, select: { id: true, title: true, docType: true, ...seq } }),
  }
  type LoaderType = keyof typeof loaders
  const directWhere = { workspaceId: input.workspaceId, title: titleFilter }
  const queryOptions: Options = { take: 5, orderBy: [{ title: "asc" }, { id: "asc" }] }

  // Typing a display ID (`TASK-12`, `opp-7`) finds that row even though no title contains it. The exact hit leads its
  // group; the title matches that follow skip it, so it never shows twice.
  const exact = parseDisplayId(input.query)
  const exactType = exact && Object.hasOwn(loaders, exact.type) ? (exact.type as LoaderType) : null
  const exactHit = exact && exactType
    ? loaders[exactType]({ workspaceId: input.workspaceId, seqPrefix: exact.prefix, seqNumber: exact.number }, { take: 1 })
    : Promise.resolve([])

  const [opportunities, solutions, experiments, roadmapItems, tasks, feedback, docs, exactRows] = await Promise.all([
    loaders.opportunity(directWhere, queryOptions),
    loaders.solution(directWhere, queryOptions),
    loaders.experiment(directWhere, queryOptions),
    loaders.roadmapItem(directWhere, queryOptions),
    loaders.task(directWhere, queryOptions),
    loaders.feedback(directWhere, queryOptions),
    loaders.doc(directWhere, queryOptions),
    exactHit,
  ])

  const lead = <T extends { id: string }>(type: LoaderType, rows: T[]): T[] => {
    if (type !== exactType || exactRows.length === 0) return rows
    const hit = exactRows[0] as unknown as T
    return [hit, ...rows.filter((row) => row.id !== hit.id)].slice(0, 5)
  }

  const helpResults = searchHelp(input.query, 5)

  // Every non-help result routes through the shared builder, so a search hit
  // and the URL an MCP tool hands a human always land on the same screen.
  type Seq = { seqPrefix: string | null; seqNumber: number | null }
  const item = <R extends { id: string; title: string } & Seq>(type: LoaderType, row: R, ctx: string | undefined, opportunityId?: string): WorkspaceSearchItem => {
    const displayId = displayIdFromRow(type, row)
    return {
      type,
      id: row.id,
      displayId,
      title: row.title,
      context: ctx,
      href: entityPath({ orgSlug: input.orgSlug, workspaceSlug: input.workspaceSlug, type, id: row.id, displayId, opportunityId }),
    }
  }

  return {
    query: input.query,
    groups: [
      { type: "opportunity", label: "Opportunities", items: lead("opportunity", opportunities).map((row) => item("opportunity", row, row.status)) },
      { type: "solution", label: "Solutions", items: lead("solution", solutions).map((row) => item("solution", row, context(row.status, row.opportunity.title), row.opportunity.id)) },
      { type: "experiment", label: "Experiments", items: lead("experiment", experiments).map((row) => item("experiment", row, context(row.status, row.conclusion))) },
      { type: "roadmapItem", label: "Roadmap", items: lead("roadmapItem", roadmapItems).map((row) => item("roadmapItem", row, context(row.horizon, row.status))) },
      { type: "task", label: "Tasks", items: lead("task", tasks).map((row) => item("task", row, context(row.status, row.priority))) },
      { type: "feedback", label: "Feedback", items: lead("feedback", feedback).map((row) => item("feedback", row, context(row.type, row.status))) },
      { type: "doc", label: "Docs", items: lead("doc", docs).map((row) => item("doc", row, row.docType)) },
      {
        type: "help",
        label: "User Guide",
        items: helpResults.map((row) => ({
          type: "help" as const,
          id: `${row.slug}:${row.anchor ?? "root"}`,
          title: row.title,
          context: context(row.heading ?? row.section),
          href: `/help/${row.slug}${row.anchor ? "#" + row.anchor : ""}`,
        })),
      },
    ],
  }
}
