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
import { isGoogleDriveUrl } from "@/lib/google-drive-links"
import { captureScreenshot, resolveProtectionBypassSecret, type CaptureScreenshotResult } from "@/lib/capture-screenshot"

/** A failure whose message is safe and useful to show the person who asked. */
export class ArtifactThumbnailError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ArtifactThumbnailError"
  }
}

/**
 * A capture that was declined on purpose rather than one that failed. The
 * background scheduler stays quiet for it; the manual paths show its message.
 */
export class ArtifactThumbnailSkipped extends ArtifactThumbnailError {
  constructor(message: string) {
    super(message)
    this.name = "ArtifactThumbnailSkipped"
  }
}

export type ArtifactThumbnailCapture = {
  artifactId: string
  isHtml: boolean
  capture: CaptureScreenshotResult
  saved: Awaited<ReturnType<typeof setArtifactRevisionThumbnail>>
}

/**
 * Per-process guard against stacking sandbox boots for one artifact. Instance-local
 * by design (cheap, no schema); a durable cross-instance limit is a follow-up.
 */
const capturesInFlight = new Set<string>()

/** Drop query and fragment: they can carry tokens and are not needed to identify the page. */
function stripQueryAndFragment(url: string): string {
  try {
    const parsed = new URL(url)
    parsed.search = ""
    parsed.hash = ""
    return parsed.toString()
  } catch {
    return url.split(/[?#]/)[0]
  }
}

export async function captureAndStoreArtifactThumbnail(input: {
  artifactId: string
  workspaceId: string
  revisionId?: string
  fullPage?: boolean
  viewport?: { width: number; height: number }
}): Promise<ArtifactThumbnailCapture> {
  if (capturesInFlight.has(input.artifactId)) {
    throw new ArtifactThumbnailError("A screenshot capture for this artifact is already in progress.")
  }
  capturesInFlight.add(input.artifactId)
  try {
    return await captureAndStoreArtifactThumbnailUnguarded(input)
  } finally {
    capturesInFlight.delete(input.artifactId)
  }
}

async function captureAndStoreArtifactThumbnailUnguarded(input: {
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
    // The capture browser is not signed in to Google, so it would photograph a
    // sign-in page and store it as this link's thumbnail. Drive links are
    // previewed live in the viewer instead (components/docs/artifact-preview.tsx).
    if (isGoogleDriveUrl(revision.externalUrl)) {
      throw new ArtifactThumbnailSkipped("Google Drive links are previewed live and are not screenshotted: the capture browser cannot sign in to Google.")
    }
    capture = await captureScreenshot({
      url: revision.externalUrl,
      fullPage: input.fullPage,
      viewport: input.viewport,
      // Only sent when the target is one of our own deployments; see
      // resolveProtectionBypassSecret for why the decision cannot be left to the
      // page-level origin check alone.
      protectionBypassSecret: resolveProtectionBypassSecret(revision.externalUrl),
      // Otherwise, for a prototype on another project in the configured Vercel team, mint a
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
      sourceUrl: isHtml ? null : stripQueryAndFragment(capture.finalUrl),
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
      if (error instanceof ArtifactThumbnailSkipped) return
      console.warn(
        `[artifact-thumbnail] background capture failed for artifact ${input.artifactId} revision ${input.revisionId}: ` +
          (error instanceof Error ? error.message : String(error))
      )
    }
  })
}
