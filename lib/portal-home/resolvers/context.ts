import type { AppPrismaClient } from "@/lib/db"

export interface ResolveContextBase {
  prisma: AppPrismaClient
  workspace: {
    id: string
    orgSlug: string
    workspaceSlug: string
    roadmapPublic: boolean
    feedbackEnabled: boolean
  }
}

/** A portal visitor. Public data only; gated on roadmapPublic / feedbackEnabled. */
export interface CustomerResolveContext extends ResolveContextBase {
  audience: "customer"
}

/**
 * A workspace member (the team home and the admin editor canvas). Internal data
 * (private roadmap items, feedback without a public gate), in-app links, Doc
 * links. Only resolveHomeForTeam / resolveHomeForMember construct this; the
 * customer pipeline cannot, so nothing here can reach a customer.
 */
export interface TeamResolveContext extends ResolveContextBase {
  audience: "team"
}

export type ResolveContext = CustomerResolveContext | TeamResolveContext

/** What callers (pages, routes) supply; the resolve functions add the audience. */
export type ResolveInput = ResolveContextBase

export function isTeamContext(ctx: ResolveContext): ctx is TeamResolveContext {
  return ctx.audience === "team"
}

/** Base path of the surfaces a viewer of this audience links to. */
export function surfaceBase(ctx: ResolveContext): string {
  return ctx.audience === "team"
    ? `/${ctx.workspace.orgSlug}/${ctx.workspace.workspaceSlug}`
    : `/portal/${ctx.workspace.orgSlug}/${ctx.workspace.workspaceSlug}`
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

/**
 * THE team (internal) roadmap predicate: everything in the workspace that is not
 * archived, INCLUDING private items. It demands a TeamResolveContext, which only
 * the team/member resolve entry points can build, so a customer code path cannot
 * call it without a cast. Do not export a context-free variant.
 */
export function internalRoadmapItemWhere(ctx: TeamResolveContext) {
  return { workspaceId: ctx.workspace.id, status: { not: "ARCHIVED" } }
}
