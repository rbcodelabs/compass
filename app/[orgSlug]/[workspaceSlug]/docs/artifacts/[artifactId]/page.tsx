import { auth } from "@/auth"
import getPrisma from "@/lib/db"
import { notFound, redirect } from "next/navigation"
import { ArtifactDetail } from "@/components/docs/artifact-detail"
import { getArtifactStorage } from "@/lib/artifact-storage"
import { buildSandboxedHtml, getArtifactDecisions, toArtifactDetailDto } from "@/lib/artifacts"

export default async function ArtifactPage({ params }: { params: Promise<{ orgSlug: string; workspaceSlug: string; artifactId: string }> }) {
  const session = await auth()
  if (!session?.user?.id) redirect("/login")
  const { orgSlug, workspaceSlug, artifactId } = await params
  const prisma = getPrisma()
  const workspace = await prisma.workspace.findFirst({ where: { slug: workspaceSlug, organization: { slug: orgSlug }, members: { some: { userId: session.user.id } } }, select: { id: true } })
  if (!workspace) notFound()
  const artifact = await prisma.artifact.findFirst({ where: { id: artifactId, workspaceId: workspace.id }, include: { currentRevision: true, revisions: { orderBy: { revisionNumber: "desc" } }, links: { where: { linkedType: "SOLUTION" }, select: { linkedId: true } } } })
  if (!artifact) notFound()
  let html: string | undefined
  if (artifact.currentRevision?.blobPathname) {
    const bytes = await getArtifactStorage().get(artifact.currentRevision.blobPathname)
    if (bytes) html = buildSandboxedHtml(new TextDecoder().decode(bytes))
  }
  const rawSolutions = await prisma.solution.findMany({ where: { opportunity: { workspaceId: workspace.id } }, select: { id: true, title: true }, orderBy: { title: "asc" } })
  const linkedIds = new Set(artifact.links.map((link) => link.linkedId))
  const decisions = await getArtifactDecisions(workspace.id, artifactId)
  return <ArtifactDetail artifact={toArtifactDetailDto(artifact)} html={html} workspaceId={workspace.id} basePath={`/${orgSlug}/${workspaceSlug}/docs`} decisions={decisions} solutions={rawSolutions.map((solution) => ({ ...solution, linked: linkedIds.has(solution.id) }))} />
}
