/**
 * Screen-responsive starter question grounding & cache state for the empty Agent Rail
 * (TASK-174 — Direction A: Quiet Editorial Stack).
 *
 * Reuses `resolveAgentPageContext` as the mandatory front door so same-origin relative
 * path checks, `orgSlug`/`workspaceSlug` tenant isolation, `SECTION_LABELS` allowlisting
 * (which deliberately excludes `/agent`), and workspace-scoped `resolveWorkItem` lookups
 * remain single-sourced.
 */

import { createHash } from "node:crypto"
import { resolveAgentPageContext, type AgentPageContext } from "@/lib/agent-page-context"
import getPrisma, { type AppPrismaClient, type AppTransactionClient } from "@/lib/db"
import { DocumentError, documentRevision, hydrateDocument } from "@/lib/document-service"
import { parseJsonCanvas } from "@/lib/json-canvas"
import {
  readEntityLinksOpportunityKeyResultPointer,
  readEntityLinksOpportunityObjective,
} from "@/lib/links/readers"
import { getTaskLinks, getTasksLinkedTo, type TaskLinkView } from "@/lib/task-links-read"
import { type ThinkingModelSource } from "@/lib/thinking-model/resolve"
import { excludeToolApprovals } from "@/lib/tool-approval/gate"

export type PageSuggestionMode = "reading" | "authoring"

export type PageSuggestionWorkspace = ThinkingModelSource & {
  id: string
  orgSlug: string
  workspaceSlug: string
  name?: string | null
  nowLimit?: number | null
  nextLimit?: number | null
}

export type PageSuggestionContext = {
  /** Concise display label for `Viewing · <label>` (<= 64 chars). */
  label: string
  /** Normalized relative path from `resolveAgentPageContext` (pathname + validated `?detail=` only). */
  path: string
  /** Workspace section label (e.g. "Roadmap", "Discovery", "Docs"). */
  section: string
  /** "authoring" for blank/stub Docs (< 50 non-whitespace chars or empty CANVAS); "reading" otherwise. */
  mode: PageSuggestionMode
  /** Deterministic content state token so unchanged screens hit server/client caches. */
  revisionKey: string
  /** Grounded workspace/entity lines wrapped in `<untrusted_workspace_content>` by the model layer. */
  groundingLines: string[]
}

export type ResolvePageSuggestionContextInput = {
  pageUrl: unknown
  workspace: PageSuggestionWorkspace
  prisma?: AppPrismaClient
  nowMs?: number
}

const LABEL_MAX_CHARS = 64
const DOC_EXCERPT_MAX_CHARS = 3_500
const SECTION_BUCKET_MS = 5 * 60_000

const GENERIC_SHORT_TITLE_RE = /^\(?(untitled|draft|new|blank|note|doc|document|rfc|spec|canvas|page|todo|tbd)\)?$/i

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex")
}

function isMissingColumnError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "P2021" || error.code === "P2022")
  )
}

function cleanInline(value: string | null | undefined, maxChars: number): string | null {
  const flat = value?.replace(/\s+/g, " ").trim()
  if (!flat) return null
  if (flat.length <= maxChars) return flat
  return `${flat.slice(0, maxChars - 1).trimEnd()}…`
}

function cleanBlock(value: string | null | undefined, maxChars: number): string | null {
  const trimmed = value?.replace(/\r\n/g, "\n").trim()
  if (!trimmed) return null
  if (trimmed.length <= maxChars) return trimmed
  return `${trimmed.slice(0, maxChars - 1).trimEnd()}…`
}

function formatDateIso(value: Date | string | null | undefined): string | null {
  if (!value) return null
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString().slice(0, 10) : null
  }
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : null
}

function revisionFromDateOrDigest(updatedAt: Date | string | null | undefined, lines: readonly string[]): string {
  if (updatedAt instanceof Date && Number.isFinite(updatedAt.getTime())) {
    return updatedAt.toISOString()
  }
  if (typeof updatedAt === "string" && updatedAt.trim().length > 0) {
    const parsed = new Date(updatedAt)
    if (Number.isFinite(parsed.getTime())) return parsed.toISOString()
  }
  return `digest:${sha256Hex(lines.join("\n")).slice(0, 24)}`
}

export function buildViewingLabel(section: string, entity: AgentPageContext["entity"]): string {
  if (!entity) {
    return cleanInline(section, LABEL_MAX_CHARS) ?? "Workspace"
  }
  const rawTitle = entity.title.replace(/\s+/g, " ").trim()
  const displayTitle = rawTitle === "(untitled)" ? "Untitled" : rawTitle
  const needsPrefix =
    !displayTitle ||
    GENERIC_SHORT_TITLE_RE.test(displayTitle) ||
    displayTitle.length < 6
  const combined = needsPrefix
    ? `${entity.typeLabel}: ${displayTitle || "Untitled"}`
    : displayTitle
  return cleanInline(combined, LABEL_MAX_CHARS) ?? entity.typeLabel
}

function extractMarkdownHeadings(markdown: string, limit = 10): string[] {
  const headings: string[] = []
  const lines = markdown.replace(/\r\n/g, "\n").split("\n")
  let inFence = false
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const match = /^(#{1,3})\s+(.+?)\s*#*\s*$/.exec(line)
    if (match) {
      const cleaned = cleanInline(`${match[1]} ${match[2]}`, 120)
      if (cleaned) {
        headings.push(cleaned)
        if (headings.length >= limit) break
      }
    }
  }
  return headings
}

async function safeQuery<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn()
  } catch {
    return fallback
  }
}

async function loadActiveOkrLines(prisma: AppPrismaClient, workspaceId: string): Promise<string[]> {
  if (!prisma.oKRCycle?.findFirst) return []
  const cycle = await safeQuery(
    () =>
      prisma.oKRCycle.findFirst({
        where: { workspaceId, status: "ACTIVE" },
        orderBy: { updatedAt: "desc" },
        select: {
          title: true,
          objectives: {
            where: { workspaceId },
            orderBy: { sortOrder: "asc" },
            take: 3,
            select: {
              title: true,
              status: true,
              keyResults: {
                orderBy: { sortOrder: "asc" },
                take: 2,
                select: { title: true, current: true, target: true, unit: true },
              },
            },
          },
        },
      }),
    null,
  )
  if (!cycle) return []
  const lines = [`Active OKR cycle: ${cleanInline(cycle.title, 120) ?? "Current cycle"}`]
  for (const obj of cycle.objectives) {
    const krs = obj.keyResults
      .map((kr) => `${cleanInline(kr.title, 80)} (${kr.current}/${kr.target}${kr.unit ? ` ${kr.unit}` : ""})`)
      .join("; ")
    lines.push(
      `Objective: ${cleanInline(obj.title, 120)} [${obj.status}]${krs ? ` — KRs: ${krs}` : ""}`,
    )
  }
  return lines
}

async function resolveDocContext(
  prisma: AppPrismaClient,
  workspace: PageSuggestionWorkspace,
  base: AgentPageContext,
  entity: NonNullable<AgentPageContext["entity"]>,
): Promise<{ mode: PageSuggestionMode; revisionKey: string; groundingLines: string[] }> {
  const fallbackLines = [
    `Section: ${base.section}`,
    `Document title: ${entity.title}`,
    ...(entity.meta ? [`Document type: ${entity.meta}`] : []),
  ]

  type DocRow = {
    id: string
    title: string
    docType: string | null
    kind?: string | null
    content: string | null
    storageProvider?: string | null
    contentRef?: string | null
    revision?: string | null
    updatedAt: Date
  }

  let row: DocRow | null = null
  if (prisma.doc?.findFirst) {
    try {
      row = await prisma.doc.findFirst({
        where: { id: entity.id, workspaceId: workspace.id },
        select: {
          id: true,
          title: true,
          docType: true,
          kind: true,
          content: true,
          storageProvider: true,
          contentRef: true,
          revision: true,
          updatedAt: true,
        },
      })
    } catch (error) {
      if (!isMissingColumnError(error)) throw error
      row = await prisma.doc.findFirst({
        where: { id: entity.id, workspaceId: workspace.id },
        select: {
          id: true,
          title: true,
          docType: true,
          content: true,
          updatedAt: true,
        },
      })
    }
  }

  if (!row) {
    return {
      mode: "reading",
      revisionKey: revisionFromDateOrDigest(null, fallbackLines),
      groundingLines: fallbackLines,
    }
  }

  const revKey = documentRevision({
    revision: row.revision ?? null,
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt : new Date(row.updatedAt),
  })

  let hydratedContent: string | null = row.content
  try {
    const hydrated = await hydrateDocument(workspace.id, {
      content: row.content,
      storageProvider: row.storageProvider ?? null,
      contentRef: row.contentRef ?? null,
    })
    hydratedContent = hydrated.content
  } catch (error) {
    if (!(error instanceof DocumentError)) {
      console.warn("[agent-page-suggestions] hydrateDocument failed; falling back to summary.", error)
    }
    return {
      mode: "reading",
      revisionKey: revKey,
      groundingLines: [
        `Section: ${base.section}`,
        `Document title: ${cleanInline(row.title, 160) ?? entity.title}`,
        `Document type: ${row.docType ?? "STANDARD"}${row.kind ? ` (kind: ${row.kind})` : ""}`,
      ],
    }
  }

  const lines: string[] = [
    `Section: ${base.section}`,
    `Document title: ${cleanInline(row.title, 160) ?? entity.title}`,
    `Document type: ${row.docType ?? "STANDARD"}${row.kind ? ` (kind: ${row.kind})` : ""}`,
  ]

  if (row.docType === "CANVAS") {
    const parsed = parseJsonCanvas(hydratedContent ?? "")
    const nodes = parsed.ok ? parsed.canvas.nodes : []
    if (nodes.length === 0) {
      const extraContext = await loadAuthoringWorkspaceHints(prisma, workspace.id)
      return {
        mode: "authoring",
        revisionKey: revKey,
        groundingLines: [...lines, "Canvas state: Empty canvas (0 nodes)", ...extraContext],
      }
    }
    const nodeSnippets = nodes
      .slice(0, 20)
      .map((node) => cleanInline(node.label ?? node.text ?? node.file ?? node.url ?? node.type, 160))
      .filter((snippet): snippet is string => Boolean(snippet))
    const excerpt = cleanBlock(nodeSnippets.join("\n"), DOC_EXCERPT_MAX_CHARS)
    lines.push(`Canvas nodes (${nodes.length}, edges ${parsed.ok ? parsed.canvas.edges.length : 0}):`)
    if (excerpt) lines.push(excerpt)
    return {
      mode: "reading",
      revisionKey: revKey,
      groundingLines: lines,
    }
  }

  const body = hydratedContent ?? ""
  const nonWhitespaceLen = body.replace(/\s+/g, "").length
  const mode: PageSuggestionMode = nonWhitespaceLen < 50 ? "authoring" : "reading"

  if (mode === "authoring") {
    const stub = cleanBlock(body, 200)
    lines.push(
      stub
        ? `Document body (stub, ${nonWhitespaceLen} non-whitespace chars): ${stub}`
        : "Document body: Blank document (0 chars)",
    )
    const extraContext = await loadAuthoringWorkspaceHints(prisma, workspace.id)
    lines.push(...extraContext)
    return {
      mode: "authoring",
      revisionKey: revKey,
      groundingLines: lines,
    }
  }

  const headings = extractMarkdownHeadings(body, 10)
  if (headings.length > 0) {
    lines.push(`Headings: ${headings.join(" | ")}`)
  }
  const excerpt = cleanBlock(body, DOC_EXCERPT_MAX_CHARS)
  if (excerpt) {
    lines.push(`Body excerpt:\n${excerpt}`)
  }

  return {
    mode: "reading",
    revisionKey: revKey,
    groundingLines: lines,
  }
}

async function loadAuthoringWorkspaceHints(prisma: AppPrismaClient, workspaceId: string): Promise<string[]> {
  const hints: string[] = []
  const okrLines = await loadActiveOkrLines(prisma, workspaceId)
  hints.push(...okrLines.slice(0, 3))
  if (prisma.opportunity?.findMany) {
    const opps = await safeQuery(
      () =>
        prisma.opportunity.findMany({
          where: { workspaceId, status: "EXPLORING" },
          orderBy: { updatedAt: "desc" },
          take: 3,
          select: { title: true },
        }),
      [],
    )
    if (opps.length > 0) {
      hints.push(`Active discovery opportunities: ${opps.map((o) => cleanInline(o.title, 90)).filter(Boolean).join("; ")}`)
    }
  }
  if (prisma.roadmapItem?.findMany) {
    const items = await safeQuery(
      () =>
        prisma.roadmapItem.findMany({
          where: { workspaceId, status: "ACTIVE", horizon: "NOW" },
          orderBy: { updatedAt: "desc" },
          take: 3,
          select: { title: true },
        }),
      [],
    )
    if (items.length > 0) {
      hints.push(`Roadmap NOW items: ${items.map((r) => cleanInline(r.title, 90)).filter(Boolean).join("; ")}`)
    }
  }
  return hints
}

async function resolveEntityContext(
  prisma: AppPrismaClient,
  workspace: PageSuggestionWorkspace,
  base: AgentPageContext,
  entity: NonNullable<AgentPageContext["entity"]>,
): Promise<{ mode: PageSuggestionMode; revisionKey: string; groundingLines: string[] }> {
  if (entity.type === "doc") {
    return resolveDocContext(prisma, workspace, base, entity)
  }

  const defaultSummaryLines = () => [
    `Section: ${base.section}`,
    `Entity: ${entity.typeLabel} "${entity.title}"`,
    ...(entity.status ? [`Status: ${entity.status}`] : []),
    ...(entity.meta ? [`Meta: ${entity.meta}`] : []),
    ...(entity.description ? [`Summary: ${entity.description}`] : []),
  ]

  switch (entity.type) {
    case "opportunity": {
      const row = prisma.opportunity?.findFirst
        ? await safeQuery(
            () =>
              prisma.opportunity.findFirst({
                where: { id: entity.id, workspaceId: workspace.id },
                select: {
                  id: true,
                  title: true,
                  status: true,
                  customerSegment: true,
                  description: true,
                  updatedAt: true,
                  solutions: { select: { title: true, status: true }, take: 5 },
                  _count: { select: { solutions: true, feedback: true } },
                },
              }),
            null,
          )
        : null
      if (!row) {
        const lines = defaultSummaryLines()
        return { mode: "reading", revisionKey: revisionFromDateOrDigest(null, lines), groundingLines: lines }
      }
      const [objLinks, krLinks] = await Promise.all([
        safeQuery(
          () => readEntityLinksOpportunityObjective(prisma as unknown as AppTransactionClient, workspace.id, { opportunityIds: [row.id] }),
          [],
        ),
        safeQuery(
          () => readEntityLinksOpportunityKeyResultPointer(prisma as unknown as AppTransactionClient, workspace.id, { opportunityIds: [row.id] }),
          [],
        ),
      ])
      const [linkedObjectives, linkedKrs] = await Promise.all([
        objLinks.length > 0 && prisma.objective?.findMany
          ? safeQuery(
              () =>
                prisma.objective.findMany({
                  where: { id: { in: objLinks.map((l) => l.toId) }, workspaceId: workspace.id },
                  select: { title: true },
                }),
              [],
            )
          : Promise.resolve([]),
        krLinks.length > 0 && prisma.keyResult?.findMany
          ? safeQuery(
              () =>
                prisma.keyResult.findMany({
                  where: { id: { in: krLinks.map((l) => l.toId) }, objective: { workspaceId: workspace.id } },
                  select: { title: true },
                }),
              [],
            )
          : Promise.resolve([]),
      ])
      const lines: string[] = [
        `Section: ${base.section}`,
        `${entity.typeLabel}: ${cleanInline(row.title, 160) ?? entity.title}`,
        `Status: ${row.status}`,
      ]
      if (row.customerSegment) lines.push(`Customer segment: ${cleanInline(row.customerSegment, 140)}`)
      if (linkedObjectives.length > 0) {
        lines.push(`Linked Objectives: ${linkedObjectives.map((o) => cleanInline(o.title, 100)).filter(Boolean).join("; ")}`)
      }
      if (linkedKrs.length > 0) {
        lines.push(`Linked Key Results: ${linkedKrs.map((k) => cleanInline(k.title, 100)).filter(Boolean).join("; ")}`)
      }
      const solCount = row._count?.solutions ?? row.solutions?.length ?? 0
      const fbCount = row._count?.feedback ?? 0
      lines.push(`Counts: ${solCount} solutions, ${fbCount} feedback items`)
      if (row.solutions?.length) {
        lines.push(
          `Solutions: ${row.solutions.map((s) => `${cleanInline(s.title, 80)} (${s.status})`).join("; ")}`,
        )
      }
      const desc = cleanBlock(row.description, 1_200)
      if (desc) lines.push(`Description: ${desc}`)
      return {
        mode: "reading",
        revisionKey: revisionFromDateOrDigest(row.updatedAt, lines),
        groundingLines: lines,
      }
    }

    case "solution": {
      const row = prisma.solution?.findFirst
        ? await safeQuery(
            () =>
              prisma.solution.findFirst({
                where: { id: entity.id, workspaceId: workspace.id },
                select: {
                  id: true,
                  title: true,
                  status: true,
                  description: true,
                  updatedAt: true,
                  opportunity: { select: { title: true } },
                  assumptions: { select: { title: true, status: true, riskLevel: true } },
                  roadmapItems: {
                    where: { status: "ACTIVE" },
                    select: { title: true, horizon: true },
                    take: 3,
                  },
                },
              }),
            null,
          )
        : null
      if (!row) {
        const lines = defaultSummaryLines()
        return { mode: "reading", revisionKey: revisionFromDateOrDigest(null, lines), groundingLines: lines }
      }
      const assumptions = row.assumptions ?? []
      const untestedCount = assumptions.filter((a) => a.status === "UNTESTED").length
      const highRiskUntestedCount = assumptions.filter(
        (a) => a.status === "UNTESTED" && a.riskLevel === "HIGH",
      ).length
      const lines: string[] = [
        `Section: ${base.section}`,
        `${entity.typeLabel}: ${cleanInline(row.title, 160) ?? entity.title}`,
        `Status: ${row.status}`,
      ]
      if (row.opportunity?.title) {
        lines.push(`Parent Opportunity: ${cleanInline(row.opportunity.title, 140)}`)
      }
      lines.push(
        `Assumptions: ${assumptions.length} total (${untestedCount} untested, ${highRiskUntestedCount} high-risk untested)`,
      )
      if (assumptions.length > 0) {
        lines.push(
          `Top assumptions: ${assumptions
            .slice(0, 4)
            .map((a) => `${cleanInline(a.title, 80)} [${a.riskLevel}/${a.status}]`)
            .join("; ")}`,
        )
      }
      if (row.roadmapItems?.length) {
        lines.push(
          `Roadmap horizon: ${row.roadmapItems.map((r) => `${r.horizon} (${cleanInline(r.title, 80)})`).join("; ")}`,
        )
      }
      const desc = cleanBlock(row.description, 1_200)
      if (desc) lines.push(`Description: ${desc}`)
      return {
        mode: "reading",
        revisionKey: revisionFromDateOrDigest(row.updatedAt, lines),
        groundingLines: lines,
      }
    }

    case "roadmapItem": {
      const row = prisma.roadmapItem?.findFirst
        ? await safeQuery(
            () =>
              prisma.roadmapItem.findFirst({
                where: { id: entity.id, workspaceId: workspace.id },
                select: {
                  id: true,
                  title: true,
                  horizon: true,
                  status: true,
                  startDate: true,
                  endDate: true,
                  description: true,
                  updatedAt: true,
                  opportunity: { select: { title: true } },
                  solution: { select: { title: true } },
                  keyResult: { select: { title: true } },
                },
              }),
            null,
          )
        : null
      if (!row) {
        const lines = defaultSummaryLines()
        return { mode: "reading", revisionKey: revisionFromDateOrDigest(null, lines), groundingLines: lines }
      }
      const linkedTasks = await safeQuery(
        () =>
          getTasksLinkedTo(prisma, {
            workspaceIds: [workspace.id],
            linkedType: "ROADMAP_ITEM",
            linkedIds: [row.id],
          }),
        [],
      )
      const statusCounts = new Map<string, number>()
      for (const entry of linkedTasks) {
        statusCounts.set(entry.task.status, (statusCounts.get(entry.task.status) ?? 0) + 1)
      }
      const lines: string[] = [
        `Section: ${base.section}`,
        `Roadmap item: ${cleanInline(row.title, 160) ?? entity.title}`,
        `Horizon: ${row.horizon} (status: ${row.status})`,
      ]
      if (row.opportunity?.title) lines.push(`Linked Opportunity: ${cleanInline(row.opportunity.title, 140)}`)
      if (row.solution?.title) lines.push(`Linked Solution: ${cleanInline(row.solution.title, 140)}`)
      if (row.keyResult?.title) lines.push(`Linked Key Result: ${cleanInline(row.keyResult.title, 140)}`)
      const startIso = formatDateIso(row.startDate)
      const endIso = formatDateIso(row.endDate)
      if (startIso || endIso) {
        lines.push(`Dates: ${startIso ?? "unset"} to ${endIso ?? "unset"}`)
      }
      if (linkedTasks.length > 0) {
        const breakdown = [...statusCounts.entries()].map(([st, c]) => `${st}: ${c}`).join(", ")
        lines.push(`Linked tasks (${linkedTasks.length}): ${breakdown}`)
      } else {
        lines.push("Linked tasks: 0")
      }
      const desc = cleanBlock(row.description, 1_000)
      if (desc) lines.push(`Description: ${desc}`)
      return {
        mode: "reading",
        revisionKey: revisionFromDateOrDigest(row.updatedAt, lines),
        groundingLines: lines,
      }
    }

    case "experiment": {
      const row = prisma.experiment?.findFirst
        ? await safeQuery(
            () =>
              prisma.experiment.findFirst({
                where: { id: entity.id, workspaceId: workspace.id },
                select: {
                  id: true,
                  title: true,
                  status: true,
                  hypothesis: true,
                  method: true,
                  killCondition: true,
                  conclusion: true,
                  conclusionReason: true,
                  updatedAt: true,
                  assumption: {
                    select: {
                      title: true,
                      solution: { select: { title: true } },
                    },
                  },
                },
              }),
            null,
          )
        : null
      if (!row) {
        const lines = defaultSummaryLines()
        return { mode: "reading", revisionKey: revisionFromDateOrDigest(null, lines), groundingLines: lines }
      }
      const lines: string[] = [
        `Section: ${base.section}`,
        `Experiment: ${cleanInline(row.title, 160) ?? entity.title}`,
        `Status: ${row.status}`,
      ]
      if (row.assumption?.title) {
        lines.push(
          `Parent Assumption: ${cleanInline(row.assumption.title, 140)}${
            row.assumption.solution?.title ? ` (Solution: ${cleanInline(row.assumption.solution.title, 100)})` : ""
          }`,
        )
      }
      const hyp = cleanBlock(row.hypothesis, 600)
      if (hyp) lines.push(`Hypothesis: ${hyp}`)
      const kill = cleanBlock(row.killCondition, 400)
      if (kill) lines.push(`Success / kill criteria: ${kill}`)
      const method = cleanBlock(row.method, 400)
      if (method) lines.push(`Method: ${method}`)
      if (row.conclusion) {
        lines.push(
          `Outcome: ${row.conclusion}${row.conclusionReason ? ` — ${cleanInline(row.conclusionReason, 300)}` : ""}`,
        )
      }
      return {
        mode: "reading",
        revisionKey: revisionFromDateOrDigest(row.updatedAt, lines),
        groundingLines: lines,
      }
    }

    case "objective": {
      const row = prisma.objective?.findFirst
        ? await safeQuery(
            () =>
              prisma.objective.findFirst({
                where: { id: entity.id, workspaceId: workspace.id },
                select: {
                  id: true,
                  title: true,
                  status: true,
                  description: true,
                  updatedAt: true,
                  cycle: { select: { title: true, status: true } },
                  parentKeyResult: { select: { title: true } },
                  keyResults: {
                    orderBy: { sortOrder: "asc" },
                    take: 6,
                    select: { title: true, current: true, target: true, unit: true },
                  },
                },
              }),
            null,
          )
        : null
      if (!row) {
        const lines = defaultSummaryLines()
        return { mode: "reading", revisionKey: revisionFromDateOrDigest(null, lines), groundingLines: lines }
      }
      const lines: string[] = [
        `Section: ${base.section}`,
        `${entity.typeLabel}: ${cleanInline(row.title, 160) ?? entity.title}`,
        `Status: ${row.status}`,
        `Cycle: ${row.cycle?.title ? `${cleanInline(row.cycle.title, 120)} (${row.cycle.status})` : "Persistent / cross-cycle"}`,
      ]
      if (row.parentKeyResult?.title) {
        lines.push(`Supporting parent KR: ${cleanInline(row.parentKeyResult.title, 120)}`)
      }
      if (row.keyResults?.length) {
        lines.push(
          `Child Key Results: ${row.keyResults
            .map((kr) => `${cleanInline(kr.title, 90)} (${kr.current}/${kr.target}${kr.unit ? ` ${kr.unit}` : ""})`)
            .join("; ")}`,
        )
      }
      const desc = cleanBlock(row.description, 800)
      if (desc) lines.push(`Description: ${desc}`)
      return {
        mode: "reading",
        revisionKey: revisionFromDateOrDigest(row.updatedAt, lines),
        groundingLines: lines,
      }
    }

    case "keyResult": {
      const row = prisma.keyResult?.findFirst
        ? await safeQuery(
            () =>
              prisma.keyResult.findFirst({
                where: { id: entity.id, objective: { workspaceId: workspace.id } },
                select: {
                  id: true,
                  title: true,
                  current: true,
                  target: true,
                  unit: true,
                  updatedAt: true,
                  objective: {
                    select: {
                      title: true,
                      status: true,
                      cycle: { select: { title: true } },
                      keyResults: {
                        orderBy: { sortOrder: "asc" },
                        take: 6,
                        select: { id: true, title: true, current: true, target: true, unit: true },
                      },
                    },
                  },
                },
              }),
            null,
          )
        : null
      if (!row) {
        const lines = defaultSummaryLines()
        return { mode: "reading", revisionKey: revisionFromDateOrDigest(null, lines), groundingLines: lines }
      }
      const siblings = (row.objective?.keyResults ?? []).filter((kr) => kr.id !== row.id)
      const lines: string[] = [
        `Section: ${base.section}`,
        `${entity.typeLabel}: ${cleanInline(row.title, 160) ?? entity.title}`,
        `Progress: ${row.current} / ${row.target}${row.unit ? ` ${row.unit}` : ""}`,
      ]
      if (row.objective?.title) {
        lines.push(`Parent Objective: ${cleanInline(row.objective.title, 140)} [${row.objective.status}]`)
      }
      if (row.objective?.cycle?.title) {
        lines.push(`Cycle: ${cleanInline(row.objective.cycle.title, 120)}`)
      }
      if (siblings.length > 0) {
        lines.push(
          `Sibling KRs: ${siblings
            .map((kr) => `${cleanInline(kr.title, 80)} (${kr.current}/${kr.target}${kr.unit ? ` ${kr.unit}` : ""})`)
            .join("; ")}`,
        )
      }
      return {
        mode: "reading",
        revisionKey: revisionFromDateOrDigest(row.updatedAt, lines),
        groundingLines: lines,
      }
    }

    case "task": {
      const row = prisma.task?.findFirst
        ? await safeQuery(
            () =>
              prisma.task.findFirst({
                where: { id: entity.id, workspaceId: workspace.id },
                select: {
                  id: true,
                  title: true,
                  status: true,
                  priority: true,
                  dueDate: true,
                  description: true,
                  updatedAt: true,
                },
              }),
            null,
          )
        : null
      if (!row) {
        const lines = defaultSummaryLines()
        return { mode: "reading", revisionKey: revisionFromDateOrDigest(null, lines), groundingLines: lines }
      }
      const linkMap = await safeQuery<Map<string, TaskLinkView[]>>(
        () => getTaskLinks(prisma, [{ id: row.id, workspaceId: workspace.id }]),
        new Map<string, TaskLinkView[]>(),
      )
      const taskLinks = linkMap.get(row.id) ?? []
      const oppIds = taskLinks.filter((l) => l.linkedType === "OPPORTUNITY").map((l) => l.linkedId)
      const solIds = taskLinks.filter((l) => l.linkedType === "SOLUTION").map((l) => l.linkedId)
      const rmIds = taskLinks.filter((l) => l.linkedType === "ROADMAP_ITEM").map((l) => l.linkedId)
      const [opps, sols, rms] = await Promise.all([
        oppIds.length > 0 && prisma.opportunity?.findMany
          ? safeQuery(
              () =>
                prisma.opportunity.findMany({
                  where: { id: { in: oppIds }, workspaceId: workspace.id },
                  select: { title: true },
                }),
              [],
            )
          : Promise.resolve([]),
        solIds.length > 0 && prisma.solution?.findMany
          ? safeQuery(
              () =>
                prisma.solution.findMany({
                  where: { id: { in: solIds }, workspaceId: workspace.id },
                  select: { title: true },
                }),
              [],
            )
          : Promise.resolve([]),
        rmIds.length > 0 && prisma.roadmapItem?.findMany
          ? safeQuery(
              () =>
                prisma.roadmapItem.findMany({
                  where: { id: { in: rmIds }, workspaceId: workspace.id },
                  select: { title: true, horizon: true },
                }),
              [],
            )
          : Promise.resolve([]),
      ])
      const lines: string[] = [
        `Section: ${base.section}`,
        `Task: ${cleanInline(row.title, 160) ?? entity.title}`,
        `Status: ${row.status} (priority: ${row.priority})`,
      ]
      const dueIso = formatDateIso(row.dueDate)
      if (dueIso) lines.push(`Due date: ${dueIso}`)
      if (opps.length > 0) lines.push(`Linked Opportunities: ${opps.map((o) => cleanInline(o.title, 100)).join("; ")}`)
      if (sols.length > 0) lines.push(`Linked Solutions: ${sols.map((s) => cleanInline(s.title, 100)).join("; ")}`)
      if (rms.length > 0) {
        lines.push(
          `Linked Roadmap items: ${rms.map((r) => `${cleanInline(r.title, 100)} (${r.horizon})`).join("; ")}`,
        )
      }
      const desc = cleanBlock(row.description, 1_000)
      if (desc) lines.push(`Description: ${desc}`)
      return {
        mode: "reading",
        revisionKey: revisionFromDateOrDigest(row.updatedAt, lines),
        groundingLines: lines,
      }
    }

    case "feedback": {
      const row = prisma.feedbackItem?.findFirst
        ? await safeQuery(
            () =>
              prisma.feedbackItem.findFirst({
                where: { id: entity.id, workspaceId: workspace.id },
                select: {
                  id: true,
                  title: true,
                  type: true,
                  status: true,
                  source: true,
                  voteCount: true,
                  submitterName: true,
                  description: true,
                  updatedAt: true,
                  opportunity: { select: { title: true } },
                },
              }),
            null,
          )
        : null
      if (!row) {
        const lines = defaultSummaryLines()
        return { mode: "reading", revisionKey: revisionFromDateOrDigest(null, lines), groundingLines: lines }
      }
      const lines: string[] = [
        `Section: ${base.section}`,
        `Feedback: ${cleanInline(row.title, 160) ?? entity.title}`,
        `Type: ${row.type} | Status: ${row.status} | Source: ${row.source} | Votes: ${row.voteCount}`,
      ]
      if (row.opportunity?.title) {
        lines.push(`Linked Opportunity: ${cleanInline(row.opportunity.title, 140)}`)
      }
      const body = cleanBlock(row.description, 1_200)
      if (body) lines.push(`Quote / body: ${body}`)
      return {
        mode: "reading",
        revisionKey: revisionFromDateOrDigest(row.updatedAt, lines),
        groundingLines: lines,
      }
    }

    case "review": {
      const row = prisma.reviewRequest?.findFirst
        ? await safeQuery(
            () =>
              prisma.reviewRequest.findFirst({
                where: { id: entity.id, workspaceId: workspace.id, ...excludeToolApprovals },
                select: {
                  id: true,
                  state: true,
                  gateType: true,
                  updatedAt: true,
                  currentRevision: {
                    select: {
                      title: true,
                      summary: true,
                      options: {
                        orderBy: { sortOrder: "asc" },
                        select: { label: true },
                      },
                    },
                  },
                },
              }),
            null,
          )
        : null
      if (!row) {
        const lines = defaultSummaryLines()
        return { mode: "reading", revisionKey: revisionFromDateOrDigest(null, lines), groundingLines: lines }
      }
      const lines: string[] = [
        `Section: ${base.section}`,
        `Decision request: ${cleanInline(row.currentRevision?.title, 160) ?? entity.title}`,
        `State: ${row.state} (gate: ${row.gateType})`,
      ]
      const options = (row.currentRevision?.options ?? [])
        .map((o) => cleanInline(o.label, 80))
        .filter((label): label is string => Boolean(label))
      if (options.length > 0) {
        lines.push(`Options: ${options.join(" | ")}`)
      }
      const summary = cleanBlock(row.currentRevision?.summary, 1_200)
      if (summary) lines.push(`Context: ${summary}`)
      return {
        mode: "reading",
        revisionKey: revisionFromDateOrDigest(row.updatedAt, lines),
        groundingLines: lines,
      }
    }

    case "assumption": {
      const row = prisma.assumption?.findFirst
        ? await safeQuery(
            () =>
              prisma.assumption.findFirst({
                where: { id: entity.id, solution: { workspaceId: workspace.id } },
                select: {
                  id: true,
                  title: true,
                  status: true,
                  riskLevel: true,
                  description: true,
                  updatedAt: true,
                  solution: { select: { title: true } },
                  experiments: { select: { title: true, status: true }, take: 4 },
                },
              }),
            null,
          )
        : null
      if (!row) {
        const lines = defaultSummaryLines()
        return { mode: "reading", revisionKey: revisionFromDateOrDigest(null, lines), groundingLines: lines }
      }
      const lines: string[] = [
        `Section: ${base.section}`,
        `Assumption: ${cleanInline(row.title, 160) ?? entity.title}`,
        `Status: ${row.status} | Risk level: ${row.riskLevel}`,
      ]
      if (row.solution?.title) {
        lines.push(`Parent Solution: ${cleanInline(row.solution.title, 140)}`)
      }
      if (row.experiments?.length) {
        lines.push(
          `Experiments: ${row.experiments.map((e) => `${cleanInline(e.title, 80)} (${e.status})`).join("; ")}`,
        )
      }
      const desc = cleanBlock(row.description, 1_000)
      if (desc) lines.push(`Description: ${desc}`)
      return {
        mode: "reading",
        revisionKey: revisionFromDateOrDigest(row.updatedAt, lines),
        groundingLines: lines,
      }
    }

    case "artifact": {
      const row = prisma.artifact?.findFirst
        ? await safeQuery(
            () =>
              prisma.artifact.findFirst({
                where: { id: entity.id, workspaceId: workspace.id },
                select: {
                  id: true,
                  title: true,
                  status: true,
                  kind: true,
                  sourceType: true,
                  description: true,
                  updatedAt: true,
                },
              }),
            null,
          )
        : null
      if (!row) {
        const lines = defaultSummaryLines()
        return { mode: "reading", revisionKey: revisionFromDateOrDigest(null, lines), groundingLines: lines }
      }
      const lines: string[] = [
        `Section: ${base.section}`,
        `Artifact: ${cleanInline(row.title, 160) ?? entity.title}`,
        `Status: ${row.status} | Kind: ${row.kind ?? "DOCUMENT"} | Source: ${row.sourceType}`,
      ]
      const desc = cleanBlock(row.description, 1_000)
      if (desc) lines.push(`Description: ${desc}`)
      return {
        mode: "reading",
        revisionKey: revisionFromDateOrDigest(row.updatedAt, lines),
        groundingLines: lines,
      }
    }

    default: {
      const lines = defaultSummaryLines()
      return {
        mode: "reading",
        revisionKey: revisionFromDateOrDigest(null, lines),
        groundingLines: lines,
      }
    }
  }
}

async function resolveSectionContext(
  prisma: AppPrismaClient,
  workspace: PageSuggestionWorkspace,
  base: AgentPageContext,
  nowMs: number,
): Promise<{ mode: PageSuggestionMode; revisionKey: string; groundingLines: string[] }> {
  const lines: string[] = [`Section: ${base.section} (board / overview)`]
  if (workspace.name) {
    lines.push(`Workspace: ${cleanInline(workspace.name, 100)}`)
  }

  const okrLines = await loadActiveOkrLines(prisma, workspace.id)
  lines.push(...okrLines)

  switch (base.section) {
    case "Roadmap": {
      if (prisma.roadmapItem?.findMany) {
        const activeItems = await safeQuery(
          () =>
            prisma.roadmapItem.findMany({
              where: { workspaceId: workspace.id, status: "ACTIVE" },
              orderBy: [{ sortOrder: "asc" }, { updatedAt: "desc" }],
              take: 60,
              select: { title: true, horizon: true },
            }),
          [],
        )
        const nowItems = activeItems.filter((i) => i.horizon === "NOW")
        const nextItems = activeItems.filter((i) => i.horizon === "NEXT")
        const laterItems = activeItems.filter((i) => i.horizon === "LATER")
        const limitsNote = [
          typeof workspace.nowLimit === "number" ? `NOW limit ${workspace.nowLimit}` : null,
          typeof workspace.nextLimit === "number" ? `NEXT limit ${workspace.nextLimit}` : null,
        ]
          .filter(Boolean)
          .join(", ")
        lines.push(
          `Active roadmap counts: NOW=${nowItems.length}, NEXT=${nextItems.length}, LATER=${laterItems.length}${
            limitsNote ? ` (${limitsNote})` : ""
          }`,
        )
        if (nowItems.length > 0) {
          lines.push(
            `NOW items: ${nowItems
              .slice(0, 5)
              .map((i) => cleanInline(i.title, 90))
              .filter(Boolean)
              .join("; ")}`,
          )
        }
        if (nextItems.length > 0) {
          lines.push(
            `NEXT items: ${nextItems
              .slice(0, 5)
              .map((i) => cleanInline(i.title, 90))
              .filter(Boolean)
              .join("; ")}`,
          )
        }
      }
      break
    }

    case "Discovery":
    case "Solutions": {
      if (prisma.opportunity?.findMany) {
        const opps = await safeQuery(
          () =>
            prisma.opportunity.findMany({
              where: { workspaceId: workspace.id, status: "EXPLORING" },
              orderBy: { updatedAt: "desc" },
              take: 4,
              select: { title: true, customerSegment: true },
            }),
          [],
        )
        if (opps.length > 0) {
          lines.push(
            `Top EXPLORING opportunities: ${opps
              .map((o) =>
                o.customerSegment
                  ? `${cleanInline(o.title, 90)} (${cleanInline(o.customerSegment, 50)})`
                  : cleanInline(o.title, 90),
              )
              .filter(Boolean)
              .join("; ")}`,
          )
        }
      }
      if (base.section === "Solutions" && prisma.solution?.findMany) {
        const sols = await safeQuery(
          () =>
            prisma.solution.findMany({
              where: { workspaceId: workspace.id, status: { notIn: ["ARCHIVED", "KILLED"] } },
              orderBy: { updatedAt: "desc" },
              take: 4,
              select: { title: true, status: true },
            }),
          [],
        )
        if (sols.length > 0) {
          lines.push(
            `Active solutions: ${sols.map((s) => `${cleanInline(s.title, 80)} (${s.status})`).join("; ")}`,
          )
        }
      }
      break
    }

    case "Tasks": {
      if (prisma.task?.findMany) {
        const activeTasks = await safeQuery(
          () =>
            prisma.task.findMany({
              where: {
                workspaceId: workspace.id,
                status: { in: ["IN_PROGRESS", "IN_REVIEW", "BLOCKED"] },
              },
              orderBy: { updatedAt: "desc" },
              take: 40,
              select: { title: true, status: true, priority: true },
            }),
          [],
        )
        const inProgress = activeTasks.filter((t) => t.status === "IN_PROGRESS")
        const inReview = activeTasks.filter((t) => t.status === "IN_REVIEW")
        const blocked = activeTasks.filter((t) => t.status === "BLOCKED")
        lines.push(
          `Active task counts: IN_PROGRESS=${inProgress.length}, IN_REVIEW=${inReview.length}, BLOCKED=${blocked.length}`,
        )
        const highlighted = [...blocked.slice(0, 3), ...inReview.slice(0, 2), ...inProgress.slice(0, 3)].slice(0, 5)
        if (highlighted.length > 0) {
          lines.push(
            `Highlighted tasks: ${highlighted
              .map((t) => `${cleanInline(t.title, 80)} [${t.status}/${t.priority}]`)
              .join("; ")}`,
          )
        }
      }
      break
    }

    case "Experiments": {
      if (prisma.experiment?.findMany) {
        const exps = await safeQuery(
          () =>
            prisma.experiment.findMany({
              where: { workspaceId: workspace.id },
              orderBy: { updatedAt: "desc" },
              take: 4,
              select: { title: true, status: true },
            }),
          [],
        )
        if (exps.length > 0) {
          lines.push(
            `Recent experiments: ${exps.map((e) => `${cleanInline(e.title, 80)} (${e.status})`).join("; ")}`,
          )
        }
      }
      break
    }

    case "Feedback": {
      if (prisma.feedbackItem?.findMany) {
        const items = await safeQuery(
          () =>
            prisma.feedbackItem.findMany({
              where: { workspaceId: workspace.id, status: "OPEN" },
              orderBy: [{ voteCount: "desc" }, { createdAt: "desc" }],
              take: 4,
              select: { title: true, type: true, voteCount: true },
            }),
          [],
        )
        if (items.length > 0) {
          lines.push(
            `Top open feedback: ${items
              .map((f) => `${cleanInline(f.title, 80)} (${f.type}, ${f.voteCount} votes)`)
              .join("; ")}`,
          )
        }
      }
      break
    }

    case "Docs":
    case "Canvas": {
      if (prisma.doc?.findMany) {
        const docs = await safeQuery(
          () =>
            prisma.doc.findMany({
              where: { workspaceId: workspace.id },
              orderBy: { updatedAt: "desc" },
              take: 4,
              select: { title: true, docType: true },
            }),
          [],
        )
        if (docs.length > 0) {
          lines.push(
            `Recent docs: ${docs
              .map((d) => `${cleanInline(d.title, 80)}${d.docType && d.docType !== "STANDARD" ? ` (${d.docType})` : ""}`)
              .join("; ")}`,
          )
        }
      }
      break
    }

    case "Decisions":
    case "Reviews": {
      if (prisma.reviewRequest?.findMany) {
        const reviews = await safeQuery(
          () =>
            prisma.reviewRequest.findMany({
              where: { workspaceId: workspace.id, state: "PENDING", ...excludeToolApprovals },
              orderBy: { updatedAt: "desc" },
              take: 4,
              select: { currentRevision: { select: { title: true } } },
            }),
          [],
        )
        const titles = reviews
          .map((r) => cleanInline(r.currentRevision?.title, 90))
          .filter((t): t is string => Boolean(t))
        if (titles.length > 0) {
          lines.push(`Pending decisions: ${titles.join("; ")}`)
        }
      }
      break
    }

    case "Home":
    default: {
      if (prisma.opportunity?.findMany) {
        const opps = await safeQuery(
          () =>
            prisma.opportunity.findMany({
              where: { workspaceId: workspace.id, status: "EXPLORING" },
              orderBy: { updatedAt: "desc" },
              take: 3,
              select: { title: true },
            }),
          [],
        )
        if (opps.length > 0) {
          lines.push(
            `Active opportunities: ${opps.map((o) => cleanInline(o.title, 90)).filter(Boolean).join("; ")}`,
          )
        }
      }
      if (prisma.roadmapItem?.findMany) {
        const nowItems = await safeQuery(
          () =>
            prisma.roadmapItem.findMany({
              where: { workspaceId: workspace.id, status: "ACTIVE", horizon: "NOW" },
              orderBy: { updatedAt: "desc" },
              take: 3,
              select: { title: true },
            }),
          [],
        )
        if (nowItems.length > 0) {
          lines.push(
            `Roadmap NOW: ${nowItems.map((i) => cleanInline(i.title, 90)).filter(Boolean).join("; ")}`,
          )
        }
      }
      break
    }
  }

  const bucket = Math.floor(nowMs / SECTION_BUCKET_MS)
  const digest = sha256Hex(lines.join("\n")).slice(0, 24)
  return {
    mode: "reading",
    revisionKey: `bucket:${bucket}:${digest}`,
    groundingLines: lines,
  }
}

export async function resolvePageSuggestionContext({
  pageUrl,
  workspace,
  prisma = getPrisma(),
  nowMs = Date.now(),
}: ResolvePageSuggestionContextInput): Promise<PageSuggestionContext | null> {
  const base = await resolveAgentPageContext({ pageUrl, workspace })
  if (!base) return null

  const label = buildViewingLabel(base.section, base.entity)
  const resolved = base.entity
    ? await resolveEntityContext(prisma, workspace, base, base.entity)
    : await resolveSectionContext(prisma, workspace, base, nowMs)

  return {
    label,
    path: base.path,
    section: base.section,
    mode: resolved.mode,
    revisionKey: resolved.revisionKey,
    groundingLines: resolved.groundingLines,
  }
}

// ── Server LRU Cache & Per-User Sliding-Window Rate Limiter ─────────────────
// Kept here so `app/api/agent/page-suggestions/route.ts` exports only `GET`
// (per Next.js 16 Route Handler export rules) while tests can reset state cleanly.

export const SERVER_SUGGESTIONS_CACHE_MAX = 200
export const SERVER_SUGGESTIONS_CACHE_TTL_MS = 10 * 60_000
export const USER_SUGGESTIONS_RATE_WINDOW_MS = 10 * 60_000
export const USER_SUGGESTIONS_MAX_UNCACHED_CALLS = 30

type ServerCacheEntry = {
  suggestions: string[]
  cachedAt: number
}

const serverSuggestionsCache = new Map<string, ServerCacheEntry>()
const userUncachedCallWindows = new Map<string, number[]>()

export function buildServerSuggestionCacheKey(
  workspaceId: string,
  path: string,
  revisionKey: string,
): string {
  return sha256Hex(`${workspaceId}\0${path}\0${revisionKey}`)
}

export function getServerCachedSuggestions(key: string, nowMs = Date.now()): string[] | null {
  const entry = serverSuggestionsCache.get(key)
  if (!entry) return null
  if (nowMs - entry.cachedAt >= SERVER_SUGGESTIONS_CACHE_TTL_MS) {
    serverSuggestionsCache.delete(key)
    return null
  }
  // Refresh LRU order
  serverSuggestionsCache.delete(key)
  serverSuggestionsCache.set(key, entry)
  return entry.suggestions
}

export function setServerCachedSuggestions(
  key: string,
  suggestions: string[],
  nowMs = Date.now(),
): void {
  if (suggestions.length === 0) return
  serverSuggestionsCache.delete(key)
  if (serverSuggestionsCache.size >= SERVER_SUGGESTIONS_CACHE_MAX) {
    const oldestKey = serverSuggestionsCache.keys().next().value
    if (oldestKey !== undefined) {
      serverSuggestionsCache.delete(oldestKey)
    }
  }
  serverSuggestionsCache.set(key, { suggestions: [...suggestions], cachedAt: nowMs })
}

export function consumePageSuggestionRateLimit(userId: string, nowMs = Date.now()): boolean {
  const cutoff = nowMs - USER_SUGGESTIONS_RATE_WINDOW_MS
  const existing = userUncachedCallWindows.get(userId) ?? []
  const recent = existing.filter((ts) => ts > cutoff)
  if (recent.length >= USER_SUGGESTIONS_MAX_UNCACHED_CALLS) {
    userUncachedCallWindows.set(userId, recent)
    return false
  }
  recent.push(nowMs)
  userUncachedCallWindows.delete(userId)
  if (userUncachedCallWindows.size >= 500) {
    const oldestUser = userUncachedCallWindows.keys().next().value
    if (oldestUser !== undefined) userUncachedCallWindows.delete(oldestUser)
  }
  userUncachedCallWindows.set(userId, recent)
  return true
}

/** Test seam: clears both the server LRU cache and the per-user rate limiter. */
export function resetPageSuggestionsServerState(): void {
  serverSuggestionsCache.clear()
  userUncachedCallWindows.clear()
}
