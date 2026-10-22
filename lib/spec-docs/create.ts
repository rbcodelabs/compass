/**
 * createSpecCore: the one function behind the createSpec server action and the MCP create_spec tool, plus listSpecDocs behind list_specs.
 *
 * A Spec is a SPEC-type Doc scoped to a Solution (a Spec) or an Opportunity (a Discovery Plan) by one DOC_SPECIFIES_SCOPE entity_links
 * row. Creation is an explicit action, never a side effect of a read, and it is NOT idempotent by design: every call makes a NEW doc,
 * because a solution may have many specs and an opportunity many plans. There is no uniqueness and no deterministic-id fallback.
 *
 * The caller must already have authorized the actor for `workspaceId` (server action: workspace membership; MCP: the tool gate). This
 * module still re-verifies the scope record INSIDE that workspace, so a scope in another workspace and one that does not exist are
 * indistinguishable ("not found"), and the link service re-verifies both endpoints again in the write transaction.
 *
 * Backend: the doc goes through document-service (Postgres and DSQL alike; Geode-pilot workspaces get the guarded path). DSQL has no
 * foreign keys, so a failed link write is compensated by deleting the doc we just made instead of relying on a database rollback.
 */
import { randomUUID } from "node:crypto"
import getPrisma from "@/lib/db"
import { createDocument, deleteDocument, documentRevision } from "@/lib/document-service"
import { DOC_SPECIFIES_SCOPE_LINK_TYPE } from "@/lib/links/registry"
import { linkEntities } from "@/lib/links/service"
import { TypedLinkError, getLinkedKeyResultsBySolution, getLinkedObjectivesByOpportunity, runTypedLinkTransaction, type LinkSource } from "@/lib/typed-links"
import { listDocIdsForScope, type SpecScopeType } from "@/lib/spec-docs/scopes"
import {
  renderSpecTemplate,
  specDocTitle,
  specTemplateId,
  type SpecRecord,
  type SpecTemplateData,
  type SpecTemplateVariant,
} from "@/lib/spec-docs/template"

export type CreateSpecInput = {
  workspaceId: string
  scopeType: SpecScopeType
  scopeId: string
  /** `default` (generated from the scope's records) or `blank` (headings only). */
  template?: SpecTemplateVariant
  /** A short distinguishing label ("v2", "Pricing"), appended to the title and stored in metadata. */
  label?: string
}

export type SpecActor = { userId: string | null; authorName: string; source: LinkSource }

export type CreateSpecResult =
  | { ok: true; docId: string; title: string; scopeType: SpecScopeType; scopeId: string; linkId: string; template: string; label: string | null }
  | { ok: false; error: "scope_not_found" | "link_failed" }

const SCOPE_LABEL: Record<SpecScopeType, string> = { SOLUTION: "Solution", OPPORTUNITY: "Opportunity" }
/** The one user-safe message for a scope that is missing, in another workspace, or has a NULL workspace. */
export function scopeNotFoundMessage(scopeType: SpecScopeType): string {
  return `${SCOPE_LABEL[scopeType]} not found in this workspace.`
}

const bySortThenCreated = [{ sortOrder: "asc" as const }, { createdAt: "asc" as const }, { id: "asc" as const }]
const RISK_RANK: Record<string, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 }
/** The Discovery Plan lists only this many open assumptions, riskiest first. */
export const RISKIEST_ASSUMPTIONS_LIMIT = 10

type Db = ReturnType<typeof getPrisma>

const record = (row: { id: string; title: string }): SpecRecord => ({ id: row.id, title: row.title })

async function artifactsLinkedToSolutions(db: Db, workspaceId: string, solutionIds: string[]): Promise<SpecRecord[]> {
  if (solutionIds.length === 0) return []
  const links = await db.artifactLink.findMany({
    where: { workspaceId, linkedType: "SOLUTION", linkedId: { in: solutionIds } },
    select: { artifactId: true },
  })
  const ids = [...new Set(links.map((link) => link.artifactId))]
  if (ids.length === 0) return []
  const artifacts = await db.artifact.findMany({
    where: { id: { in: ids }, workspaceId, status: "ACTIVE" },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, title: true },
  })
  return artifacts.map(record)
}

async function experimentsForAssumptions(db: Db, workspaceId: string, assumptionIds: string[]): Promise<SpecRecord[]> {
  if (assumptionIds.length === 0) return []
  const experiments = await db.experiment.findMany({
    where: { workspaceId, assumptionId: { in: assumptionIds } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, title: true },
  })
  return experiments.map(record)
}

/** Every read is filtered by `workspaceId`; the scope row is looked up first and is the only gate for the rest. */
async function loadTemplateData(db: Db, workspaceId: string, scopeType: SpecScopeType, scopeId: string): Promise<SpecTemplateData | null> {
  if (scopeType === "SOLUTION") {
    const solution = await db.solution.findFirst({ where: { id: scopeId, workspaceId }, select: { id: true, title: true } })
    if (!solution) return null
    const keyResults = (await getLinkedKeyResultsBySolution(db, workspaceId, [solution.id], { preverified: true })).get(solution.id) ?? []
    const assumptions = await db.assumption.findMany({
      where: { solutionId: solution.id, solution: { workspaceId } },
      orderBy: bySortThenCreated,
      select: { id: true, title: true },
    })
    return {
      scopeType,
      solution: record(solution),
      keyResults: keyResults.map(record),
      assumptions: assumptions.map(record),
      experiments: await experimentsForAssumptions(db, workspaceId, assumptions.map((a) => a.id)),
      artifacts: await artifactsLinkedToSolutions(db, workspaceId, [solution.id]),
    }
  }

  const opportunity = await db.opportunity.findFirst({ where: { id: scopeId, workspaceId }, select: { id: true, title: true, linkedKeyResultId: true } })
  if (!opportunity) return null
  const pointerKeyResult = opportunity.linkedKeyResultId
    ? await db.keyResult.findFirst({ where: { id: opportunity.linkedKeyResultId, objective: { workspaceId } }, select: { id: true, title: true } })
    : null
  const objectives = (await getLinkedObjectivesByOpportunity(db, workspaceId, [opportunity.id], { preverified: true })).get(opportunity.id) ?? []
  const solutions = await db.solution.findMany({ where: { opportunityId: opportunity.id, workspaceId }, orderBy: bySortThenCreated, select: { id: true, title: true } })
  const solutionIds = solutions.map((s) => s.id)
  const open = solutionIds.length
    ? await db.assumption.findMany({
        where: { solutionId: { in: solutionIds }, solution: { workspaceId }, status: { in: ["UNTESTED", "TESTING"] } },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { id: true, title: true, riskLevel: true },
      })
    : []
  // Stable: riskiest first, ties keep the createdAt-then-id order the query returned.
  const riskiest = open
    .map((row, index) => ({ row, index }))
    .sort((a, b) => (RISK_RANK[a.row.riskLevel] ?? 3) - (RISK_RANK[b.row.riskLevel] ?? 3) || a.index - b.index)
    .slice(0, RISKIEST_ASSUMPTIONS_LIMIT)
    .map(({ row }) => row)
  return {
    scopeType,
    opportunity: record(opportunity),
    keyResults: pointerKeyResult ? [record(pointerKeyResult)] : [],
    objectives: objectives.map(record),
    solutions: solutions.map(record),
    assumptions: riskiest.map(record),
    experiments: await experimentsForAssumptions(db, workspaceId, riskiest.map((a) => a.id)),
    artifacts: await artifactsLinkedToSolutions(db, workspaceId, solutionIds),
  }
}

function scopeTitleOf(data: SpecTemplateData): string {
  return data.scopeType === "SOLUTION" ? data.solution.title : data.opportunity.title
}

export async function createSpecCore(input: CreateSpecInput, actor: SpecActor): Promise<CreateSpecResult> {
  const db = getPrisma()
  const data = await loadTemplateData(db, input.workspaceId, input.scopeType, input.scopeId)
  if (!data) return { ok: false, error: "scope_not_found" }

  const label = input.label?.trim() ? input.label.trim() : null
  const template = specTemplateId(input.scopeType)
  const lastSibling = await db.doc.findFirst({ where: { workspaceId: input.workspaceId, parentId: null }, orderBy: { sortOrder: "desc" }, select: { sortOrder: true } })

  const created = await createDocument(
    {
      workspaceId: input.workspaceId,
      parentId: null,
      title: specDocTitle(input.scopeType, scopeTitleOf(data), label),
      content: renderSpecTemplate(data, input.template ?? "default"),
      // Informational frontmatter only; no code reads `template` to decide behavior.
      metadata: { template, ...(label ? { label } : {}) },
      docType: "SPEC",
      sortOrder: lastSibling ? lastSibling.sortOrder + 1 : 0,
      createdById: actor.userId,
      source: actor.source,
    },
    { operationId: randomUUID(), authorId: actor.userId, authorName: actor.authorName },
  )

  try {
    const result = await runTypedLinkTransaction(db, (tx) =>
      linkEntities(tx, {
        linkType: DOC_SPECIFIES_SCOPE_LINK_TYPE,
        fromId: created.id,
        toId: input.scopeId,
        toType: input.scopeType,
        expectedWorkspaceId: input.workspaceId,
        ctx: { source: actor.source, createdById: actor.userId },
      }),
    )
    return { ok: true, docId: created.id, title: created.title, scopeType: input.scopeType, scopeId: input.scopeId, linkId: result.link.id, template, label }
  } catch (error) {
    // Compensating step: an unscoped spec doc must not be left behind (DSQL has no foreign-key or cross-statement safety net).
    await deleteCreatedDoc(created, input.workspaceId, actor)
    if (error instanceof TypedLinkError) return { ok: false, error: error.code === "NOT_FOUND" ? "scope_not_found" : "link_failed" }
    throw error
  }
}

async function deleteCreatedDoc(created: { id: string; revision: string | null; updatedAt: Date }, workspaceId: string, actor: SpecActor) {
  try {
    await deleteDocument(created.id, {
      workspaceId,
      operationId: randomUUID(),
      expectedRevision: documentRevision(created),
      authorId: actor.userId,
      authorName: actor.authorName,
    })
  } catch (cleanupError) {
    // Surface it for the operator; the caller still gets the original failure. The leftover doc has no scope link.
    console.error("[spec-docs] compensating delete of a spec doc failed", { docId: created.id, workspaceId, cleanupError })
  }
}

export type ListedSpecDoc = { id: string; title: string; label: string | null; template: string | null; updatedAt: Date }

/**
 * The SPEC docs linked to one scope, oldest link first. A thin view over the DOC_SPECIFIES_SCOPE links: a linked doc that is not a SPEC
 * (someone used the generic link tools) is left out, and so is any link whose doc is missing or in another workspace. Returns null when
 * the scope is not in `workspaceId` (missing and foreign look the same).
 */
export async function listSpecDocs(input: { workspaceId: string; scopeType: SpecScopeType; scopeId: string }): Promise<ListedSpecDoc[] | null> {
  const db = getPrisma()
  const exists =
    input.scopeType === "SOLUTION"
      ? await db.solution.findFirst({ where: { id: input.scopeId, workspaceId: input.workspaceId }, select: { id: true } })
      : await db.opportunity.findFirst({ where: { id: input.scopeId, workspaceId: input.workspaceId }, select: { id: true } })
  if (!exists) return null
  const docIds = await listDocIdsForScope(db, input.workspaceId, input.scopeType, input.scopeId)
  if (docIds.length === 0) return []
  const docs = await db.doc.findMany({
    where: { id: { in: docIds }, workspaceId: input.workspaceId, docType: "SPEC" },
    select: { id: true, title: true, metadata: true, updatedAt: true },
  })
  const byId = new Map(docs.map((doc) => [doc.id, doc]))
  return docIds.flatMap((id) => {
    const doc = byId.get(id)
    if (!doc) return []
    const metadata = doc.metadata && typeof doc.metadata === "object" && !Array.isArray(doc.metadata) ? (doc.metadata as Record<string, unknown>) : {}
    return [
      {
        id: doc.id,
        title: doc.title,
        label: typeof metadata.label === "string" ? metadata.label : null,
        template: typeof metadata.template === "string" ? metadata.template : null,
        updatedAt: doc.updatedAt,
      },
    ]
  })
}
