/**
 * Capture an artifact revision's screenshot and store it as that revision's
 * thumbnail. The one implementation behind three callers:
 *
 *  - the `capture_screenshot` MCP tool (lib/artifact-tool-handlers.ts),
 *  - the "Capture screenshot" / "Refresh screenshot" button on the artifact page
 *    (docs/actions.ts → captureArtifactThumbnail), and
 *  - the background capture scheduled whenever an EXTERNAL_LINK artifact or a new
 *    external revision is created (scheduleArtifactThumbnailCapture below).
 *
 * The target is always read from the stored revision, never taken from a caller:
 * see captureArtifactScreenshot for why that matters.
 */

import { after } from "next/server"
import getPrisma from "@/lib/db"
import { getArtifactStorage } from "@/lib/artifact-storage"
import { setArtifactRevisionThumbnail } from "@/lib/artifacts"
import { captureScreenshot, resolveProtectionBypassSecret, type CaptureScreenshotResult } from "@/lib/capture-screenshot"

/** A failure whose message is safe and useful to show the person who asked. */
export class ArtifactThumbnailError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ArtifactThumbnailError"
  }
}

export type ArtifactThumbnailCapture = {
  artifactId: string
  isHtml: boolean
  capture: CaptureScreenshotResult
  saved: Awaited<ReturnType<typeof setArtifactRevisionThumbnail>>
}

export async function captureAndStoreArtifactThumbnail(input: {
  artifactId: string
  workspaceId: string
  revisionId?: string
  fullPage?: boolean
  viewport?: { width: number; height: number }
}): Promise<ArtifactThumbnailCapture> {
  const prisma = getPrisma()
  const artifact = await prisma.artifact.findFirst({
    where: { id: input.artifactId, workspaceId: input.workspaceId },
    select: { id: true, sourceType: true, currentRevisionId: true },
  })
  if (!artifact) throw new ArtifactThumbnailError(`Artifact "${input.artifactId}" not found.`)
  if (artifact.sourceType !== "EXTERNAL_LINK" && artifact.sourceType !== "HTML_UPLOAD") {
    throw new ArtifactThumbnailError(`Screenshots are not supported for ${artifact.sourceType} artifacts.`)
  }

  const targetRevisionId = input.revisionId ?? artifact.currentRevisionId
  if (!targetRevisionId) throw new ArtifactThumbnailError("Artifact has no revision to capture.")
  const revision = await prisma.artifactRevision.findFirst({
    where: { id: targetRevisionId, artifactId: artifact.id },
    select: { id: true, revisionNumber: true, externalUrl: true, blobPathname: true },
  })
  if (!revision) throw new ArtifactThumbnailError(`Artifact revision "${targetRevisionId}" not found.`)

  const isHtml = artifact.sourceType === "HTML_UPLOAD"
  let capture: CaptureScreenshotResult
  if (isHtml) {
    if (!revision.blobPathname) throw new ArtifactThumbnailError("Artifact revision has no uploaded HTML to capture.")
    const bytes = await getArtifactStorage().get(revision.blobPathname)
    if (!bytes) throw new ArtifactThumbnailError("Artifact revision's uploaded HTML could not be read from storage.")
    capture = await captureScreenshot({
      html: new TextDecoder().decode(bytes),
      fullPage: input.fullPage,
      viewport: input.viewport,
    })
  } else {
    if (!revision.externalUrl) throw new ArtifactThumbnailError("Artifact revision has no URL to capture.")
    capture = await captureScreenshot({
      url: revision.externalUrl,
      fullPage: input.fullPage,
      viewport: input.viewport,
      // Only sent when the target is one of our own deployments; see
      // resolveProtectionBypassSecret for why the decision cannot be left to the
      // page-level origin check alone.
      protectionBypassSecret: resolveProtectionBypassSecret(revision.externalUrl),
      // Otherwise, for a prototype on another project in our Vercel team, mint a
      // one-capture key (no-op unless VERCEL_ACCESS_TOKEN is configured).
      autoProtectionBypass: true,
    })
  }

  const saved = await setArtifactRevisionThumbnail(
    {
      artifactId: artifact.id,
      workspaceId: input.workspaceId,
      revisionId: revision.id,
      png: capture.png,
      // The PNG's own dimensions, not the requested viewport — a fullPage capture
      // is taller than the viewport it was taken in.
      width: capture.image.width,
      height: capture.image.height,
      sourceUrl: isHtml ? null : capture.finalUrl,
    },
    getArtifactStorage()
  )
  return { artifactId: artifact.id, isHtml, capture, saved }
}

/**
 * Capture a new EXTERNAL_LINK revision's thumbnail after the response is sent.
 *
 * WHY `after()` AND NOT INLINE — a capture boots a sandbox and loads a third-party
 * page: seconds at best, and bounded only by the page timeout at worst. Holding
 * the create/revise response for that would make saving a link feel broken, and a
 * slow or failing page must never fail the save itself.
 *
 * WHY ONLY EXTERNAL LINKS — they are the only artifacts that display a thumbnail;
 * an HTML upload's preview is the live sandboxed iframe. Capturing those on every
 * upload would boot a sandbox to produce an image nobody sees. The MCP tool and the
 * page button still capture HTML uploads on request.
 *
 * Failures are logged and swallowed: the person who saved the link is gone by the
 * time this runs, and the artifact page's "Capture screenshot" button is the retry.
 */
export function scheduleArtifactThumbnailCapture(input: { artifactId: string; workspaceId: string; revisionId: string }) {
  if (process.env.ARTIFACT_AUTO_THUMBNAILS === "off") return
  after(async () => {
    try {
      await captureAndStoreArtifactThumbnail(input)
    } catch (error) {
      console.warn(
        `[artifact-thumbnail] background capture failed for artifact ${input.artifactId} revision ${input.revisionId}: ` +
          (error instanceof Error ? error.message : String(error))
      )
    }
  })
}
