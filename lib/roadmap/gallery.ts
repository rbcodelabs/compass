/**
 * Data and grouping for the roadmap Gallery view (`?view=gallery`).
 *
 * Each roadmap item is shown as one large card whose hero is the screenshot of an
 * Artifact linked to the item's Solution. This module is the pure + loader half; the
 * card UI lives in components/roadmap/roadmap-gallery.tsx.
 */
import type { AppTransactionClient } from "@/lib/db"
import { getSolutionsArtifactIds, toThumbnailDto, type ArtifactThumbnailDto } from "@/lib/artifacts"
import { readArtifactKind, type ArtifactKind } from "@/lib/artifact-kind"
import type { RoadmapCardData } from "@/components/roadmap/roadmap-card"
import type { SquadData } from "@/lib/types"

/** Keeps a card's payload (and filmstrip) bounded when a solution has many artifacts. */
export const MAX_GALLERY_ARTIFACTS_PER_ITEM = 6

export type GalleryArtifact = {
  id: string
  title: string
  sourceType: string
  kind: ArtifactKind
  /** null = the artifact exists but no screenshot has been captured yet. */
  thumbnail: ArtifactThumbnailDto | null
  /** Only HTML uploads and external links can be screenshotted (see captureAndStoreArtifactThumbnail). */
  capturable: boolean
}

export type GalleryItemExtras = {
  solutionStatus: string | null
  artifacts: GalleryArtifact[]
  /** Artifacts linked beyond MAX_GALLERY_ARTIFACTS_PER_ITEM. */
  moreArtifacts: number
}

export function isCapturableSource(sourceType: string): boolean {
  return sourceType === "HTML_UPLOAD" || sourceType === "EXTERNAL_LINK"
}

/** Loads, for each roadmap item with a Solution, its Solution's status and linked Artifacts (newest first, screenshots resolved). */
export async function loadRoadmapGalleryExtras(
  db: AppTransactionClient,
  workspaceId: string,
  items: ReadonlyArray<{ id: string; solutionId: string | null }>,
): Promise<Record<string, GalleryItemExtras>> {
  const solutionIds = [...new Set(items.map((item) => item.solutionId).filter((id): id is string => !!id))]
  const extras: Record<string, GalleryItemExtras> = {}
  for (const item of items) extras[item.id] = { solutionStatus: null, artifacts: [], moreArtifacts: 0 }
  if (solutionIds.length === 0) return extras

  const [solutions, artifactIdsBySolution] = await Promise.all([
    db.solution.findMany({ where: { workspaceId, id: { in: solutionIds } }, select: { id: true, status: true } }),
    getSolutionsArtifactIds(db, workspaceId, solutionIds),
  ])
  const statusBySolution = new Map(solutions.map((solution) => [solution.id, solution.status]))

  const allArtifactIds = [...new Set([...artifactIdsBySolution.values()].flat())]
  const artifacts = allArtifactIds.length === 0
    ? []
    : await db.artifact.findMany({
        where: { workspaceId, id: { in: allArtifactIds }, status: "ACTIVE" },
        orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
        select: {
          id: true,
          title: true,
          sourceType: true,
          kind: true,
          currentRevision: {
            select: { id: true, thumbnailPathname: true, thumbnailWidth: true, thumbnailHeight: true, thumbnailCapturedAt: true },
          },
        },
      })
  const byId = new Map(artifacts.map((artifact) => [artifact.id, artifact]))

  for (const item of items) {
    if (!item.solutionId) continue
    const linked = (artifactIdsBySolution.get(item.solutionId) ?? [])
      .map((id) => byId.get(id))
      .filter((artifact): artifact is NonNullable<typeof artifact> => !!artifact)
      // byId is already newest-first; keep that order per item.
      .sort((a, b) => artifacts.indexOf(a) - artifacts.indexOf(b))
    extras[item.id] = {
      solutionStatus: statusBySolution.get(item.solutionId) ?? null,
      artifacts: linked.slice(0, MAX_GALLERY_ARTIFACTS_PER_ITEM).map((artifact) => ({
        id: artifact.id,
        title: artifact.title,
        sourceType: artifact.sourceType,
        kind: readArtifactKind(artifact.kind),
        thumbnail: artifact.currentRevision ? toThumbnailDto(artifact.id, artifact.currentRevision) : null,
        capturable: isCapturableSource(artifact.sourceType),
      })),
      moreArtifacts: Math.max(0, linked.length - MAX_GALLERY_ARTIFACTS_PER_ITEM),
    }
  }
  return extras
}

/* ------------------------------------------------------------------ grouping */

export type GalleryGroupMode = "status" | "horizon" | "squad" | "none"

export type GalleryGroup = { key: string; label: string; color: string | null; items: RoadmapCardData[] }

const SOLUTION_STATUS_LABELS: Record<string, string> = {
  IDEA: "Idea",
  VALIDATED: "Validated",
  IN_DELIVERY: "In delivery",
  SHIPPED: "Shipped",
}
const SOLUTION_STATUS_ORDER = ["IN_DELIVERY", "VALIDATED", "IDEA", "SHIPPED"]
const NO_SOLUTION_KEY = "NO_SOLUTION"

const HORIZON_LABELS: Record<string, string> = { NOW: "Now", NEXT: "Next", LATER: "Later", LAUNCHING: "Launching", LAUNCHED: "Launched", SHIPPED: "Shipped" }
const HORIZON_ORDER = ["NOW", "NEXT", "LATER", "LAUNCHING", "LAUNCHED", "SHIPPED"]

/** Groups cards for the gallery. Empty groups are dropped; item order inside a group is the input order. */
export function groupGalleryItems(
  items: readonly RoadmapCardData[],
  mode: GalleryGroupMode,
  ctx: { squads: readonly SquadData[]; extras: Readonly<Record<string, GalleryItemExtras>>; noSolutionLabel?: string },
): GalleryGroup[] {
  if (mode === "none") return items.length ? [{ key: "all", label: "All items", color: null, items: [...items] }] : []

  const buckets = new Map<string, RoadmapCardData[]>()
  const keyOf = (item: RoadmapCardData): string => {
    if (mode === "horizon") return item.horizon
    if (mode === "squad") return item.squad?.id ?? "NO_SQUAD"
    return ctx.extras[item.id]?.solutionStatus ?? NO_SOLUTION_KEY
  }
  for (const item of items) {
    const key = keyOf(item)
    buckets.set(key, [...(buckets.get(key) ?? []), item])
  }

  let order: string[]
  let label: (key: string) => string
  let color: (key: string) => string | null = () => null
  if (mode === "horizon") {
    order = HORIZON_ORDER
    label = (key) => HORIZON_LABELS[key] ?? key
  } else if (mode === "squad") {
    order = [...ctx.squads.map((squad) => squad.id), "NO_SQUAD"]
    label = (key) => ctx.squads.find((squad) => squad.id === key)?.name ?? "No squad"
    color = (key) => ctx.squads.find((squad) => squad.id === key)?.color ?? null
  } else {
    order = [...SOLUTION_STATUS_ORDER, NO_SOLUTION_KEY]
    label = (key) => (key === NO_SOLUTION_KEY ? ctx.noSolutionLabel ?? "No solution" : SOLUTION_STATUS_LABELS[key] ?? key)
  }
  // Unknown keys (a status added later) still render, after the known ones.
  const keys = [...order.filter((key) => buckets.has(key)), ...[...buckets.keys()].filter((key) => !order.includes(key))]
  return keys.map((key) => ({ key, label: label(key), color: color(key), items: buckets.get(key)! }))
}
