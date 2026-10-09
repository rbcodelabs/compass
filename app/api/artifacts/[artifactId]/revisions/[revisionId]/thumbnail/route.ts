import { auth } from "@/auth"
import getPrisma from "@/lib/db"
import { getArtifactStorage } from "@/lib/artifact-storage"
import { resolveWorkspaceAccess } from "@/lib/workspace-context"

export const runtime = "nodejs"

/**
 * Serves an Artifact revision's captured screenshot to a signed-in
 * reader of its workspace.
 *
 * ACCESS — the same rule as the Artifact page itself, via resolveWorkspaceAccess:
 * a workspace member, or an org member when the org grants read-only access to
 * its workspaces. A raw membership check would be narrower than the page, so a
 * read-only viewer would see the page but a broken image.
 *
 * EVERY miss is a 404 — no session, no access, no such artifact or revision, no
 * thumbnail, bytes gone from storage. A 401/403 for "exists, but not yours" would
 * confirm the ids to anyone probing them.
 *
 * The storage pathname never leaves this handler. Responses are `private,
 * no-store`, because a shared cache must not hand one reader's workspace image
 * to the next request.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ artifactId: string; revisionId: string }> }
) {
  const notFound = () => Response.json({ error: "Not found" }, { status: 404 })

  const session = await auth()
  if (!session?.user?.id) return notFound()
  const { artifactId, revisionId } = await params

  const revision = await getPrisma().artifactRevision.findFirst({
    where: { id: revisionId, artifactId },
    select: {
      thumbnailPathname: true,
      thumbnailMimeType: true,
      artifact: {
        select: {
          workspaceId: true,
          workspace: { select: { slug: true, organization: { select: { slug: true } } } },
        },
      },
    },
  })
  if (!revision?.thumbnailPathname || !revision.artifact?.workspace?.organization) return notFound()

  const { workspace, workspaceId } = revision.artifact
  const access = await resolveWorkspaceAccess(workspace.organization.slug, workspace.slug, session.user.id)
  // Compared by id as well: the slugs came from the artifact's own row, so this
  // only fails if they now resolve to a different workspace, which must not leak.
  if (!access || access.workspaceId !== workspaceId) return notFound()

  const bytes = await getArtifactStorage().get(revision.thumbnailPathname)
  if (!bytes) return notFound()

  return new Response(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, {
    headers: {
      // Only PNG is ever written (validateThumbnailPng). Pinned rather than echoed
      // from the row so a bad value can never turn this into an HTML response.
      "Content-Type": revision.thumbnailMimeType === "image/png" ? "image/png" : "application/octet-stream",
      "Content-Length": String(bytes.byteLength),
      "Content-Disposition": `inline; filename="artifact-${artifactId}-thumbnail.png"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  })
}
