import { auth } from "@/auth"
import { notFound, redirect } from "next/navigation"
import getPrisma from "@/lib/db"
import { getArtifactStorage } from "@/lib/artifact-storage"
import { toThumbnailDto } from "@/lib/artifacts"
import { buildArtifactPresentation, type ArtifactSlideDto } from "@/lib/artifact-slides"
import { resolveWorkspaceAccess } from "@/lib/workspace-context"
import { ArtifactViewer } from "@/components/docs/artifact-viewer"

/** `?slide=N` is one-based, as shown in the UI; the viewer wants zero-based. */
function initialSlideFromParam(value: string | string[] | undefined): number {
  const raw = Array.isArray(value) ? value[0] : value
  const parsed = raw ? Number.parseInt(raw, 10) : NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed - 1 : 0
}

/**
 * Full-viewport artifact view — the same auth and data-loading shape as the
 * docked artifact page (../page.tsx), routed to via ArtifactViewer's "View
 * full screen" link. Follows the docked-panel-collapses-to-a-dedicated-route
 * pattern already shipped for the agent rail (components/agent/agent-rail.tsx's
 * `expandToPage`) rather than a modal or the browser Fullscreen API: a real
 * route with a real "Back to artifact" link, not an overlay.
 */
export default async function ArtifactFullScreenPage({ params, searchParams }: { params: Promise<{ orgSlug: string; workspaceSlug: string; artifactId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await auth()
  if (!session?.user?.id) redirect("/login")
  const { orgSlug, workspaceSlug, artifactId } = await params
  const prisma = getPrisma()
  const access = await resolveWorkspaceAccess(orgSlug, workspaceSlug, session.user.id)
  if (!access) notFound()
  const workspace = { id: access.workspaceId }
  const artifact = await prisma.artifact.findFirst({ where: { id: artifactId, workspaceId: workspace.id }, include: { currentRevision: true } })
  if (!artifact) notFound()
  let html: string | undefined
  let slides: ArtifactSlideDto[] | undefined
  if (artifact.currentRevision?.blobPathname) {
    const bytes = await getArtifactStorage().get(artifact.currentRevision.blobPathname)
    if (bytes) ({ html, slides } = buildArtifactPresentation(new TextDecoder().decode(bytes), artifact.kind))
  }
  const basePath = `/${orgSlug}/${workspaceSlug}/docs`
  return (
    // fixed + inset-0 lifts the viewer out of the workspace shell (sidebar/header)
    // so the slide really is edge-to-edge; all controls float over it.
    <div className="fixed inset-0 z-[100] bg-black">
      <ArtifactViewer
        title={artifact.title}
        html={html}
        slides={slides}
        initialSlideIndex={initialSlideFromParam((await searchParams).slide)}
        externalUrl={artifact.currentRevision?.externalUrl}
        thumbnail={artifact.currentRevision ? toThumbnailDto(artifact.id, artifact.currentRevision) : null}
        artifactId={artifact.id}
        backHref={`${basePath}/artifacts/${artifact.id}`}
        fill
      />
    </div>
  )
}
