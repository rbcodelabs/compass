import { auth } from "@/auth"
import { cookies } from "next/headers"
import { panelPinCookieName, parsePanelPin } from "@/lib/panel-pin"
import getPrisma from "@/lib/db"
import { notFound, redirect } from "next/navigation"
import { resolveWorkspaceAccess } from "@/lib/workspace-context"
import { ArtifactDetail } from "@/components/docs/artifact-detail"
import { getArtifactStorage } from "@/lib/artifact-storage"
import { getArtifactDecisions, toArtifactDetailDto } from "@/lib/artifacts"
import { buildArtifactPresentation, type ArtifactSlideDto } from "@/lib/artifact-slides"

/** `?slide=N` is one-based, as shown in the UI; the viewer wants zero-based. */
function initialSlideFromParam(value: string | string[] | undefined): number {
  const raw = Array.isArray(value) ? value[0] : value
  const parsed = raw ? Number.parseInt(raw, 10) : NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed - 1 : 0
}

export default async function ArtifactPage({ params, searchParams }: { params: Promise<{ orgSlug: string; workspaceSlug: string; artifactId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await auth()
  if (!session?.user?.id) redirect("/login")
  const { orgSlug, workspaceSlug, artifactId } = await params
  const prisma = getPrisma()
  const access = await resolveWorkspaceAccess(orgSlug, workspaceSlug, session.user.id)
  if (!access) notFound()
  const workspace = { id: access.workspaceId }
  const artifact = await prisma.artifact.findFirst({ where: { id: artifactId, workspaceId: workspace.id }, include: { currentRevision: true, revisions: { orderBy: { revisionNumber: "desc" } }, links: { where: { linkedType: "SOLUTION" }, select: { linkedId: true } } } })
  if (!artifact) notFound()
  let html: string | undefined
  let slides: ArtifactSlideDto[] | undefined
  if (artifact.currentRevision?.blobPathname) {
    const bytes = await getArtifactStorage().get(artifact.currentRevision.blobPathname)
    if (bytes) ({ html, slides } = buildArtifactPresentation(new TextDecoder().decode(bytes), artifact.kind))
  }
  const initialSlideIndex = initialSlideFromParam((await searchParams).slide)
  const rawSolutions = await prisma.solution.findMany({ where: { workspaceId: workspace.id }, select: { id: true, title: true }, orderBy: { title: "asc" } })
  const linkedIds = new Set(artifact.links.map((link) => link.linkedId))
  const decisions = await getArtifactDecisions(workspace.id, artifactId)
  const initialCommentsPin = parsePanelPin((await cookies()).get(panelPinCookieName("artifactComments"))?.value)
  return <ArtifactDetail artifact={toArtifactDetailDto(artifact)} html={html} slides={slides} initialSlideIndex={initialSlideIndex} initialCommentsPin={initialCommentsPin} workspaceId={workspace.id} basePath={`/${orgSlug}/${workspaceSlug}/docs`} decisions={decisions} solutions={rawSolutions.map((solution) => ({ ...solution, linked: linkedIds.has(solution.id) }))} />
}
