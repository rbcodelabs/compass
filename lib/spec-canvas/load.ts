import getPrisma from "@/lib/db"
import { getLinkedKeyResultsBySolution, getLinkedObjectivesByOpportunity } from "@/lib/typed-links"
import { toThumbnailDto } from "@/lib/artifacts"
import { buildArtifactPresentation } from "@/lib/artifact-slides"
import { getArtifactStorage } from "@/lib/artifact-storage"
import { shapeSpecCanvas, type RawArtifact, type RawKeyResult, type RawObjective, type SpecCanvas } from "./shape"

/**
 * Inline sandboxed frames are the only costly part of the canvas (the HTML rides
 * along in the page payload), so only the first few uploaded prototypes are
 * framed; the rest render as thumbnail/link cards.
 */
export const MAX_INLINE_PROTOTYPE_FRAMES = 3

const KEY_RESULT_SELECT = { id: true, title: true, current: true, target: true, unit: true, objectiveId: true, seqPrefix: true, seqNumber: true } as const

/**
 * Loads one Opportunity and everything that traces to it, for the read-only
 * Product Spec Canvas. `workspaceId` must come from an already-authorized
 * context (requireWorkspaceContext); every query below re-applies it, and rows
 * whose own workspace column is NULL or foreign are hidden, as on the detail page.
 * Returns null when the opportunity is not in the workspace.
 */
export async function loadSpecCanvas(args: {
  workspaceId: string
  opportunityId: string
  orgSlug: string
  workspaceSlug: string
}): Promise<SpecCanvas | null> {
  const { workspaceId, opportunityId, orgSlug, workspaceSlug } = args
  const prisma = getPrisma()

  const opportunity = await prisma.opportunity.findFirst({
    where: { id: opportunityId, workspaceId },
    select: {
      id: true, title: true, description: true, status: true, customerSegment: true, linkedKeyResultId: true, seqPrefix: true, seqNumber: true,
      evidence: { select: { id: true, sourceType: true, excerpt: true, confidence: true, sourceUrl: true }, orderBy: { createdAt: "desc" } },
      solutions: {
        // Hide a NULL / other-workspace solution instead of trusting its opportunity parent.
        where: { workspaceId },
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
        select: {
          id: true, title: true, description: true, status: true, seqPrefix: true, seqNumber: true,
          assumptions: {
            orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
            select: {
              id: true, title: true, description: true, riskLevel: true, status: true, seqPrefix: true, seqNumber: true,
              experiments: {
                where: { workspaceId },
                orderBy: { createdAt: "desc" },
                select: { id: true, title: true, hypothesis: true, status: true, conclusion: true, conclusionReason: true, assumptionId: true, seqPrefix: true, seqNumber: true },
              },
            },
          },
        },
      },
    },
  })
  if (!opportunity) return null

  const solutionIds = opportunity.solutions.map((solution) => solution.id)
  const [typedObjectives, keyResultsBySolution, legacyKeyResult, artifactLinks] = await Promise.all([
    getLinkedObjectivesByOpportunity(prisma, workspaceId, [opportunity.id], { preverified: true }),
    getLinkedKeyResultsBySolution(prisma, workspaceId, solutionIds, { preverified: true }),
    opportunity.linkedKeyResultId
      ? prisma.keyResult.findFirst({ where: { id: opportunity.linkedKeyResultId, objective: { workspaceId } }, select: KEY_RESULT_SELECT })
      : Promise.resolve(null),
    solutionIds.length
      ? prisma.artifactLink.findMany({ where: { workspaceId, linkedType: "SOLUTION", linkedId: { in: solutionIds } }, select: { artifactId: true, linkedId: true } })
      : Promise.resolve([]),
  ])

  // Link rows carry only id/title; fetch the full Key Result rows (progress needs current/target).
  const linkedKrIds = [...new Set([...keyResultsBySolution.values()].flat().map((kr) => kr.id))]
  const solutionKeyResultRows: RawKeyResult[] = linkedKrIds.length
    ? await prisma.keyResult.findMany({ where: { id: { in: linkedKrIds }, objective: { workspaceId } }, select: KEY_RESULT_SELECT })
    : []
  const krById = new Map(solutionKeyResultRows.map((kr) => [kr.id, kr]))
  const solutionKeyResults = new Map<string, RawKeyResult[]>(
    [...keyResultsBySolution].map(([solutionId, links]) => [solutionId, links.flatMap((link) => krById.get(link.id) ?? [])]),
  )

  const objectiveIds = [...new Set([
    ...(typedObjectives.get(opportunity.id) ?? []).map((objective) => objective.id),
    ...(legacyKeyResult ? [legacyKeyResult.objectiveId] : []),
    ...solutionKeyResultRows.map((kr) => kr.objectiveId),
  ])]
  const objectives: RawObjective[] = objectiveIds.length
    ? await prisma.objective.findMany({
        where: { id: { in: objectiveIds }, workspaceId },
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
        select: { id: true, title: true, description: true, status: true, seqPrefix: true, seqNumber: true },
      })
    : []

  const artifactIds = [...new Set(artifactLinks.map((link) => link.artifactId))]
  const artifactRows = artifactIds.length
    ? await prisma.artifact.findMany({
        where: { id: { in: artifactIds }, workspaceId, status: "ACTIVE" },
        orderBy: { createdAt: "asc" },
        select: {
          id: true, title: true, description: true, sourceType: true, kind: true, seqPrefix: true, seqNumber: true,
          currentRevision: { select: { id: true, externalUrl: true, blobPathname: true, thumbnailPathname: true, thumbnailWidth: true, thumbnailHeight: true, thumbnailCapturedAt: true } },
        },
      })
    : []

  const artifacts = new Map<string, RawArtifact>()
  let framed = 0
  for (const row of artifactRows) {
    let previewHtml: string | null = null
    const blobPathname = row.currentRevision?.blobPathname
    if (blobPathname && framed < MAX_INLINE_PROTOTYPE_FRAMES) {
      previewHtml = await readPreviewHtml(blobPathname, row.kind)
      if (previewHtml) framed += 1
    }
    artifacts.set(row.id, {
      id: row.id, title: row.title, description: row.description, sourceType: row.sourceType, kind: row.kind,
      seqPrefix: row.seqPrefix, seqNumber: row.seqNumber,
      externalUrl: row.currentRevision?.externalUrl ?? null,
      thumbnail: row.currentRevision ? toThumbnailDto(row.id, row.currentRevision) : null,
      previewHtml,
    })
  }
  const solutionArtifacts = new Map<string, RawArtifact[]>()
  for (const link of artifactLinks) {
    const artifact = artifacts.get(link.artifactId)
    if (artifact) solutionArtifacts.set(link.linkedId, [...(solutionArtifacts.get(link.linkedId) ?? []), artifact])
  }

  return shapeSpecCanvas(
    {
      opportunity,
      evidence: opportunity.evidence,
      objectives,
      opportunityKeyResult: legacyKeyResult,
      solutions: opportunity.solutions,
      solutionKeyResults,
      solutionArtifacts,
    },
    { orgSlug, workspaceSlug },
  )
}

/**
 * Sandbox-wrapped HTML for an uploaded prototype, or null. A missing blob or a
 * storage hiccup must not take down the whole spec: the card then degrades to
 * its thumbnail/link, which is what an unframed prototype looks like anyway.
 * A slide deck frames its first slide.
 */
async function readPreviewHtml(blobPathname: string, kind: string | null): Promise<string | null> {
  try {
    const bytes = await getArtifactStorage().get(blobPathname)
    if (!bytes) return null
    const presentation = buildArtifactPresentation(new TextDecoder().decode(bytes), kind)
    return presentation.slides?.[0]?.html ?? presentation.html
  } catch {
    return null
  }
}
