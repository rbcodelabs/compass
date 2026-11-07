import type { AppPrismaClient } from "@/lib/db"
import { isMissingColumnError } from "@/lib/db-missing-column"
import { publishedDocWhere } from "@/lib/portal-docs/service"
import { publicRoadmapItemWhere } from "./resolvers/context"

/**
 * The editorial hero's meta line ("Updated Nov 5 · 6 items in progress · 4 published docs"). Every figure is
 * derived from data a customer may already see (the public-roadmap and published-doc predicates), and a
 * figure that would be zero, or that comes from a surface this portal does not show, is null so the hero
 * omits it instead of printing a fake or empty statistic.
 */
export interface PortalHeroMeta {
  /** ISO: the most recent change to any public roadmap item or published doc. */
  updatedAt: string | null
  /** Public roadmap items on the Now horizon. */
  inProgress: number | null
  /** Published docs. */
  docs: number | null
}

export const EMPTY_HERO_META: PortalHeroMeta = { updatedAt: null, inProgress: null, docs: null }

export async function loadPortalHeroMeta(
  prisma: AppPrismaClient,
  input: { workspaceId: string; roadmapPublic: boolean; showDocs: boolean },
): Promise<PortalHeroMeta> {
  const { workspaceId, roadmapPublic, showDocs } = input
  const roadmapWhere = publicRoadmapItemWhere(workspaceId)
  const [inProgress, roadmapLatest, docStats] = await Promise.all([
    roadmapPublic ? prisma.roadmapItem.count({ where: { ...roadmapWhere, horizon: "NOW" } }) : Promise.resolve(0),
    roadmapPublic ? prisma.roadmapItem.aggregate({ where: roadmapWhere, _max: { updatedAt: true } }) : Promise.resolve(null),
    // Migration 113 not applied yet: nothing is published, so there is nothing to count. Fail closed.
    prisma.doc
      .aggregate({ where: publishedDocWhere(workspaceId), _count: { _all: true }, _max: { updatedAt: true } })
      .catch((error: unknown) => {
        if (isMissingColumnError(error)) return null
        throw error
      }),
  ])
  const docCount = docStats?._count._all ?? 0
  const stamps = [roadmapLatest?._max.updatedAt, docCount > 0 ? docStats?._max.updatedAt : null].filter((value): value is Date => value instanceof Date)
  const latest = stamps.length > 0 ? new Date(Math.max(...stamps.map((date) => date.getTime()))) : null
  return {
    updatedAt: latest ? latest.toISOString() : null,
    inProgress: inProgress > 0 ? inProgress : null,
    docs: showDocs && docCount > 0 ? docCount : null,
  }
}

/** The meta line's parts, in order, singular/plural aware. Empty when there is nothing real to say. */
export function heroMetaParts(meta: PortalHeroMeta, formatDate: (iso: string) => string): string[] {
  const parts: string[] = []
  if (meta.updatedAt) parts.push(`Updated ${formatDate(meta.updatedAt)}`)
  if (meta.inProgress) parts.push(`${meta.inProgress} ${meta.inProgress === 1 ? "item" : "items"} in progress`)
  if (meta.docs) parts.push(`${meta.docs} published ${meta.docs === 1 ? "doc" : "docs"}`)
  return parts
}
