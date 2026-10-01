import type { AppPrismaClient } from "@/lib/db"

export interface ResolveContext {
  prisma: AppPrismaClient
  workspace: {
    id: string
    orgSlug: string
    workspaceSlug: string
    roadmapPublic: boolean
    feedbackEnabled: boolean
  }
  /**
   * True only for the admin editor's member-audience resolution. Customers are
   * always false: it unlocks content (Doc links) that exists for workspace
   * members but is not public.
   */
  isWorkspaceMember: boolean
}

export function portalBase(ctx: ResolveContext): string {
  return `/portal/${ctx.workspace.orgSlug}/${ctx.workspace.workspaceSlug}`
}

/**
 * THE public-roadmap predicate. Every widget that reads roadmap items must start
 * from this, so "is this item allowed on the public portal" is defined once and
 * mirrors the public roadmap page (non-archived, not private). Callers must also
 * require workspace.roadmapPublic before querying at all.
 */
export function publicRoadmapItemWhere(workspaceId: string) {
  return { workspaceId, isPrivate: false, status: { not: "ARCHIVED" } }
}
