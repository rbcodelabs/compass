import getPrisma from "@/lib/db"
import { fail, ok } from "@/lib/mcp-output"
import { getArtifactStorage } from "@/lib/artifact-storage"
import { getMcpActor } from "@/lib/mcp-authz"
import {
  archiveArtifact as archiveArtifactCore,
  createExternalArtifact,
  createHtmlArtifact,
  linkArtifactToSolution,
  linkArtifactToDecision,
  unlinkArtifactFromDecision,
  getArtifactDecisions,
  replaceExternalArtifactRevision,
  replaceHtmlArtifactRevision,
  unlinkArtifactFromSolution,
  updateArtifactMetadata,
  validateArtifactTitle,
  validateExternalUrl,
  validateHtmlUpload,
} from "@/lib/artifacts"
import { captureAndStoreArtifactThumbnail, scheduleArtifactThumbnailCapture } from "@/lib/artifact-thumbnail"
import { assertKindAllowedForSource, parseArtifactKind, readArtifactKind } from "@/lib/artifact-kind"
import { listArtifactSlides } from "@/lib/artifact-slides"

export async function listArtifacts({ workspaceId, includeArchived = false }: { workspaceId: string; includeArchived?: boolean }) {
  const artifacts = await getPrisma().artifact.findMany({
    where: { workspaceId, ...(includeArchived ? {} : { status: "ACTIVE" }) },
    include: { currentRevision: { select: { revisionNumber: true, filename: true, externalUrl: true } }, _count: { select: { revisions: true, links: true } } },
    orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
  })
  const items = artifacts.map((artifact) => ({ ...artifact, kind: readArtifactKind(artifact.kind) }))
  return ok(`${artifacts.length} artifact${artifacts.length === 1 ? "" : "s"} found.`, { items, count: artifacts.length })
}

export async function getArtifact({ artifactId }: { artifactId: string }) {
  const prisma = getPrisma()
  const artifact = await prisma.artifact.findUnique({ where: { id: artifactId }, include: { currentRevision: true, revisions: { orderBy: { revisionNumber: "desc" } }, links: { where: { linkedType: "SOLUTION" } } } })
  if (!artifact) return fail(`Artifact "${artifactId}" not found.`)
  const solutions = artifact.links.length ? await prisma.solution.findMany({ where: { id: { in: artifact.links.map((link) => link.linkedId) }, workspaceId: artifact.workspaceId }, select: { id: true, title: true } }) : []
  const decisions = await getArtifactDecisions(artifact.workspaceId, artifact.id)
  // Blob pathnames are private storage keys, not caller-facing data. thumbnailPathname
  // is stripped for exactly the same reason blobPathname always has been — it was added
  // by migration 077 and would otherwise ride out through this spread unnoticed. The
  // remaining thumbnail_* metadata is safe and useful, so it stays.
  const safeRevisions = artifact.revisions.map(
    ({ blobPathname: _privatePath, thumbnailPathname: _privateThumbnail, ...revision }) => revision
  )
  const kind = readArtifactKind(artifact.kind)
  // A slide deck lists its slides (index + title, never the HTML) so a caller can
  // anchor a comment to one with add_comment's slideIndex. Split from the current
  // revision at request time, exactly as the viewer splits it.
  const slides = kind === "SLIDE_DECK" ? await listArtifactSlides(artifact.currentRevision?.blobPathname ?? null) : undefined
  const slideLine = slides ? `\nSlides: ${slides.length}${slides.map((slide) => `\n  ${slide.index}: ${slide.title ?? "(untitled)"}`).join("")}` : ""
  const text = [`# ${artifact.title}`, `ID: ${artifact.id}`, `Type: ${artifact.sourceType}`, `Kind: ${kind}`, `Status: ${artifact.status}`, `Current revision: ${artifact.currentRevision?.revisionNumber ?? "None"}`, `Linked solutions: ${solutions.map((solution) => `${solution.title} (${solution.id})`).join(", ") || "None"}`].join("\n")
  return ok(`${text}\nLinked decisions: ${decisions.map((decision) => `${decision.title} (${decision.id})`).join(", ") || "None"}${slideLine}`, { ...artifact, kind, ...(slides ? { slides } : {}), currentRevision: artifact.currentRevision ? { ...artifact.currentRevision, blobPathname: undefined, thumbnailPathname: undefined } : null, revisions: safeRevisions, solutions, decisions, links: undefined })
}

export async function createArtifact(input: { workspaceId: string; title: string; description?: string; sourceType: "HTML_UPLOAD" | "EXTERNAL_LINK"; kind?: string; html?: string; filename?: string; url?: string }) {
  try {
    validateArtifactTitle(input.title)
    const kind = parseArtifactKind(input.kind) ?? "DOCUMENT"
    assertKindAllowedForSource(kind, input.sourceType)
    if (input.sourceType === "HTML_UPLOAD" && (input.url !== undefined || input.html === undefined)) {
      return fail("HTML_UPLOAD requires html and does not accept url.")
    }
    if (input.sourceType === "EXTERNAL_LINK" && (input.html !== undefined || input.filename !== undefined || input.url === undefined)) {
      return fail("EXTERNAL_LINK requires url and does not accept html or filename.")
    }
    const artifact = input.sourceType === "HTML_UPLOAD"
      ? await createHtmlArtifact({ workspaceId: input.workspaceId, title: input.title, description: input.description, filename: input.filename ?? "prototype.html", mimeType: "text/html", bytes: new TextEncoder().encode(input.html ?? ""), kind, source: "MCP" }, getArtifactStorage())
      : await createExternalArtifact({ workspaceId: input.workspaceId, title: input.title, description: input.description, url: input.url ?? "", source: "MCP" })
    if (input.sourceType === "EXTERNAL_LINK" && artifact.currentRevisionId) {
      scheduleArtifactThumbnailCapture({ artifactId: artifact.id, workspaceId: input.workspaceId, revisionId: artifact.currentRevisionId })
    }
    return ok(`Artifact created.\nID: ${artifact.id}`, { id: artifact.id, title: artifact.title, sourceType: input.sourceType, kind })
  } catch (error) { return fail(error instanceof Error ? error.message : "Could not create artifact") }
}

export async function updateArtifact(input: { artifactId: string; workspaceId: string; title?: string; description?: string | null; kind?: string; html?: string; filename?: string; url?: string }) {
  try {
    const kind = parseArtifactKind(input.kind)
    if (input.html !== undefined && input.url !== undefined) return fail("Provide either html or url, not both.")
    if (input.title !== undefined) validateArtifactTitle(input.title)
    const prisma = getPrisma()
    const existing = await prisma.artifact.findFirst({ where: { id: input.artifactId, workspaceId: input.workspaceId }, select: { id: true, sourceType: true } })
    if (!existing) return fail(`Artifact "${input.artifactId}" not found.`)
    if (existing.sourceType === "HTML_UPLOAD" && input.url !== undefined) return fail("HTML_UPLOAD artifacts accept html revisions, not url.")
    if (existing.sourceType === "EXTERNAL_LINK" && (input.html !== undefined || input.filename !== undefined)) return fail("EXTERNAL_LINK artifacts accept url revisions, not html or filename.")
    if (input.filename !== undefined && input.html === undefined) return fail("filename requires html.")
    if (kind !== undefined) assertKindAllowedForSource(kind, existing.sourceType)
    if (input.html !== undefined) {
      const validation = validateHtmlUpload({ filename: input.filename ?? "prototype.html", mimeType: "text/html", bytes: new TextEncoder().encode(input.html) })
      if (!validation.ok) return fail(validation.error)
    }
    if (input.url !== undefined) validateExternalUrl(input.url)
    let revisionId: string | undefined
    if (input.html !== undefined) revisionId = (await replaceHtmlArtifactRevision({ artifactId: input.artifactId, workspaceId: input.workspaceId, filename: input.filename ?? "prototype.html", mimeType: "text/html", bytes: new TextEncoder().encode(input.html), title: input.title, description: input.description, kind, source: "MCP" }, getArtifactStorage())).id
    else if (input.url !== undefined) {
      revisionId = (await replaceExternalArtifactRevision({ artifactId: input.artifactId, workspaceId: input.workspaceId, url: input.url, title: input.title, description: input.description, source: "MCP" })).id
      scheduleArtifactThumbnailCapture({ artifactId: input.artifactId, workspaceId: input.workspaceId, revisionId })
    }
    else if (input.title !== undefined || input.description !== undefined || kind !== undefined) await updateArtifactMetadata({ artifactId: input.artifactId, workspaceId: input.workspaceId, title: input.title, description: input.description, kind })
    return ok(`Artifact updated.\nID: ${input.artifactId}`, { id: input.artifactId, revisionId })
  } catch (error) { return fail(error instanceof Error ? error.message : "Could not update artifact") }
}

/**
 * Render an EXTERNAL_LINK artifact's target in a sandboxed headless browser and
 * store the PNG as that revision's thumbnail.
 *
 * WHY THERE IS NO `url` PARAMETER — the URL is read from the revision, never taken
 * from the caller. Accepting one would hand every MCP client a
 * render-any-URL-from-our-infrastructure primitive, which is a capability they do
 * not have today and which this change was not authorized to grant. The agent can
 * already screenshot anything it likes via Bash inside its own sandbox; what it
 * could not do is make the result durable. That gap is the whole job here, and it
 * is closed without widening anyone's reach.
 *
 * HTML_UPLOAD artifacts are captured from their stored bytes, not from a URL:
 * the revision's blob is read here and handed to the browser in captureScreenshot's
 * HTML mode, which wraps it in the preview CSP and aborts every network request.
 * No URL serving the uploaded HTML is minted to make this work, and the bypass
 * secret is never involved.
 */
export async function captureArtifactScreenshot(input: {
  artifactId: string
  workspaceId: string
  revisionId?: string
  fullPage?: boolean
  viewport?: { width: number; height: number }
}) {
  try {
    const { artifactId, isHtml, capture, saved } = await captureAndStoreArtifactThumbnail(input)

    return ok(
      `Screenshot captured for revision ${saved.revisionNumber}.\n` +
        (isHtml
          ? "Rendered: the uploaded HTML (network access disabled)"
          : `Rendered: ${capture.finalUrl} (HTTP ${capture.httpStatus})`) +
        `\nID: ${artifactId}`,
      {
        artifactId,
        revisionId: saved.id,
        revisionNumber: saved.revisionNumber,
        byteSize: saved.thumbnailByteSize,
        width: saved.thumbnailWidth,
        height: saved.thumbnailHeight,
        capturedAt: saved.thumbnailCapturedAt,
        sourceUrl: saved.thumbnailSourceUrl,
        httpStatus: isHtml ? null : capture.httpStatus,
        title: capture.title,
        timings: capture.timings,
      }
    )
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Could not capture artifact screenshot")
  }
}

export async function linkArtifact({ artifactId, solutionId, workspaceId }: { artifactId: string; solutionId: string; workspaceId: string }) {
  try { const link = await linkArtifactToSolution({ artifactId, solutionId, workspaceId, source: "MCP" }); return ok(`Artifact linked to Solution.\nID: ${artifactId}`, { id: artifactId, linkId: link.id, created: link.created }) }
  catch (error) { return fail(error instanceof Error ? error.message : "Could not link artifact") }
}

export async function unlinkArtifact({ artifactId, solutionId, workspaceId }: { artifactId: string; solutionId: string; workspaceId: string }) {
  try { const result = await unlinkArtifactFromSolution({ artifactId, solutionId, workspaceId }); return ok(`Artifact unlinked from Solution.\nID: ${artifactId}`, { id: artifactId, ...result }) }
  catch (error) { return fail(error instanceof Error ? error.message : "Could not unlink artifact") }
}

export async function archiveArtifact({ artifactId, workspaceId }: { artifactId: string; workspaceId: string }) {
  try { await archiveArtifactCore({ artifactId, workspaceId }); return ok(`Artifact archived.\nID: ${artifactId}`, { id: artifactId, status: "ARCHIVED" }) }
  catch (error) { return fail(error instanceof Error ? error.message : "Could not archive artifact") }
}

export async function linkArtifactDecision(input: { workspaceId: string; artifactId: string; requestId: string }) {
  try {
    const link = await linkArtifactToDecision({ ...input, createdById: getMcpActor().userId, source: "MCP" })
    return ok(`Artifact linked to Decision as live supporting material.\nID: ${input.artifactId}`, { ...input, linkId: link.id, created: link.created })
  } catch (error) { return fail(error instanceof Error ? error.message : "Could not link artifact") }
}

export async function unlinkArtifactDecision(input: { workspaceId: string; artifactId: string; requestId: string }) {
  try {
    const result = await unlinkArtifactFromDecision(input)
    return ok(`Artifact unlinked from Decision.\nID: ${input.artifactId}`, { ...input, ...result })
  } catch (error) { return fail(error instanceof Error ? error.message : "Could not unlink artifact") }
}
