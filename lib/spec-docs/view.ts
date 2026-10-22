/**
 * Read models for the spec docs UI (phase 3): the specs listed on a solution / opportunity, and the scopes shown on a spec doc's own page.
 * Read-only. Every query carries the workspace; links whose other end is gone are dropped by the link service, so a deleted scope simply
 * leaves a spec with no scopes (the "unscoped" state), it never errors.
 */
import getPrisma from "@/lib/db"
import { entityPath } from "@/lib/entity-links"
import { listSpecDocs, type ListedSpecDoc } from "@/lib/spec-docs/create"
import { listScopesForDoc, type SpecScopeType } from "@/lib/spec-docs/scopes"
import { TypedLinkError } from "@/lib/typed-links"

type Slugs = { orgSlug: string; workspaceSlug: string }

export type SpecListItem = { id: string; title: string; label: string | null; updatedAt: string; href: string }

/** Most recently updated first; ties broken by id so the order is stable. Nothing assumes there is exactly one spec per scope. */
export function sortSpecsByUpdated<T extends { id: string; updatedAt: Date }>(specs: readonly T[]): T[] {
  return [...specs].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** The SPEC docs linked to one scope for the "Specs" / "Discovery Plans" sections, or null when the scope is not in the workspace. */
export async function loadScopeSpecItems(input: Slugs & { workspaceId: string; scopeType: SpecScopeType; scopeId: string }): Promise<SpecListItem[] | null> {
  const specs = await listSpecDocs({ workspaceId: input.workspaceId, scopeType: input.scopeType, scopeId: input.scopeId })
  if (!specs) return null
  return sortSpecsByUpdated(specs).map((spec: ListedSpecDoc) => ({
    id: spec.id,
    title: spec.title,
    label: spec.label,
    updatedAt: spec.updatedAt.toISOString(),
    href: entityPath({ orgSlug: input.orgSlug, workspaceSlug: input.workspaceSlug, type: "doc", id: spec.id }),
  }))
}

export type SpecScopeView = { scopeType: SpecScopeType; scopeId: string; title: string; href: string }

/** The scopes a spec doc specifies, with live titles and links. Empty when the doc has none (its scope was deleted). */
export async function loadSpecScopeViews(input: Slugs & { workspaceId: string; docId: string }): Promise<SpecScopeView[]> {
  const db = getPrisma()
  // The link service refuses a doc that is not in the workspace; for a read model that is the same as having no scopes.
  const scopes = await listScopesForDoc(db, input.workspaceId, input.docId).catch((error) => {
    if (error instanceof TypedLinkError) return []
    throw error
  })
  if (scopes.length === 0) return []
  const solutionIds = scopes.filter((s) => s.scopeType === "SOLUTION").map((s) => s.scopeId)
  const opportunityIds = scopes.filter((s) => s.scopeType === "OPPORTUNITY").map((s) => s.scopeId)
  const [solutions, opportunities] = await Promise.all([
    solutionIds.length ? db.solution.findMany({ where: { id: { in: solutionIds }, workspaceId: input.workspaceId }, select: { id: true, title: true, opportunityId: true } }) : [],
    opportunityIds.length ? db.opportunity.findMany({ where: { id: { in: opportunityIds }, workspaceId: input.workspaceId }, select: { id: true, title: true } }) : [],
  ])
  const slugs = { orgSlug: input.orgSlug, workspaceSlug: input.workspaceSlug }
  const views: SpecScopeView[] = []
  for (const scope of scopes) {
    if (scope.scopeType === "SOLUTION") {
      const row = solutions.find((s) => s.id === scope.scopeId)
      if (row) views.push({ scopeType: "SOLUTION", scopeId: row.id, title: row.title, href: entityPath({ ...slugs, type: "solution", id: row.id, opportunityId: row.opportunityId }) })
    } else {
      const row = opportunities.find((o) => o.id === scope.scopeId)
      if (row) views.push({ scopeType: "OPPORTUNITY", scopeId: row.id, title: row.title, href: entityPath({ ...slugs, type: "opportunity", id: row.id }) })
    }
  }
  return views
}
