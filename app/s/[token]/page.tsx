import type { Metadata } from "next"
import { cookies } from "next/headers"
import { notFound } from "next/navigation"
import { ArtifactSandboxedFrame } from "@/components/artifact-sandboxed-frame"
import { getArtifactStorage } from "@/lib/artifact-storage"
import { buildSandboxedHtml } from "@/lib/artifacts"
import { resolveShareByToken, shareSessionCookieName, verifyShareSession } from "@/lib/artifact-share"
import getPrisma from "@/lib/db"
import { ShareComments } from "./share-comments"
import { UnlockForm } from "./unlock-form"

export const dynamic = "force-dynamic"

export const metadata: Metadata = {
  title: "Shared document",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
}

/** Only the sandboxed HTML string leaves the server: no artifact id, blob path, or workspace identifier. */
async function loadSharedHtml(artifactId: string, workspaceId: string): Promise<string | null> {
  const artifact = await getPrisma().artifact.findFirst({
    where: { id: artifactId, workspaceId },
    select: { currentRevision: { select: { blobPathname: true } } },
  })
  const blobPathname = artifact?.currentRevision?.blobPathname
  if (!blobPathname) return null
  const bytes = await getArtifactStorage().get(blobPathname)
  return bytes ? buildSandboxedHtml(new TextDecoder().decode(bytes)) : null
}

export default async function SharedArtifactPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const share = await resolveShareByToken(token)
  if (!share) notFound()

  const sessionToken = (await cookies()).get(shareSessionCookieName(token))?.value
  if (!(await verifyShareSession(share, sessionToken))) {
    return (
      <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-4">
        <h1 className="text-xl font-semibold">This document is password protected</h1>
        <p className="mt-2 text-sm text-text-subtle">Enter the password you were given to view it.</p>
        <UnlockForm token={token} />
      </main>
    )
  }

  const html = await loadSharedHtml(share.artifactId, share.workspaceId)
  if (!html) {
    return (
      <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-4">
        <h1 className="text-xl font-semibold">Nothing to show yet</h1>
        <p className="mt-2 text-sm text-text-subtle">This document has no content available right now.</p>
      </main>
    )
  }
  return (
    <main className="h-screen w-screen">
      <ArtifactSandboxedFrame title="Shared document" html={html} fill />
      {/* Rendered only when the server allows commenting; the routes re-check on every call. */}
      {share.commentsEnabled ? <ShareComments token={token} /> : null}
    </main>
  )
}
