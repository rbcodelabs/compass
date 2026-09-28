import { auth } from "@/auth"
import { notFound, redirect } from "next/navigation"
import getPrisma from "@/lib/db"
import { getArtifactStorage } from "@/lib/artifact-storage"
import { buildSandboxedHtml } from "@/lib/artifacts"
import { ArtifactViewer } from "@/components/docs/artifact-viewer"

/**
 * Full-viewport artifact view — the same auth and data-loading shape as the
 * docked artifact page (../page.tsx), routed to via ArtifactViewer's "View
 * full screen" link. Follows the docked-panel-collapses-to-a-dedicated-route
 * pattern already shipped for the agent rail (components/agent/agent-rail.tsx's
 * `expandToPage`) rather than a modal or the browser Fullscreen API: a real
 * route with a real "Back to artifact" link, not an overlay.
 */
export default async function ArtifactFullScreenPage({ params }: { params: Promise<{ orgSlug: string; workspaceSlug: string; artifactId: string }> }) {
  const session = await auth()
  if (!session?.user?.id) redirect("/login")
  const { orgSlug, workspaceSlug, artifactId } = await params
  const prisma = getPrisma()
  const workspace = await prisma.workspace.findFirst({ where: { slug: workspaceSlug, organization: { slug: orgSlug }, members: { some: { userId: session.user.id } } }, select: { id: true } })
  if (!workspace) notFound()
  const artifact = await prisma.artifact.findFirst({ where: { id: artifactId, workspaceId: workspace.id }, include: { currentRevision: true } })
  if (!artifact) notFound()
  let html: string | undefined
  if (artifact.currentRevision?.blobPathname) {
    const bytes = await getArtifactStorage().get(artifact.currentRevision.blobPathname)
    if (bytes) html = buildSandboxedHtml(new TextDecoder().decode(bytes))
  }
  const basePath = `/${orgSlug}/${workspaceSlug}/docs`
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden p-4">
      <ArtifactViewer
        title={artifact.title}
        html={html}
        externalUrl={artifact.currentRevision?.externalUrl}
        artifactId={artifact.id}
        backHref={`${basePath}/artifacts/${artifact.id}`}
        fill
      />
    </div>
  )
}
