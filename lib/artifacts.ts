import { createHash, randomUUID } from "node:crypto"
import getPrisma from "@/lib/db"
import type { ArtifactStorage } from "@/lib/artifact-storage"
export { ARTIFACT_CSP, buildSandboxedHtml } from "@/lib/artifact-preview-html"

export const MAX_ARTIFACT_HTML_BYTES = 2 * 1024 * 1024
type Source = "UI" | "MCP"

export function validateArtifactTitle(value: string): string {
  const title = value.trim()
  if (!title) throw new Error("Artifact title is required")
  if (title.length > 255) throw new Error("Artifact title must be 255 characters or fewer")
  return title
}

export function validateHtmlUpload(input: { filename: string; mimeType: string; bytes: Uint8Array }):
  | { ok: true }
  | { ok: false; error: string } {
  if (!input.filename || input.filename.includes("/") || input.filename.includes("\\") || /[\u0000-\u001f\u007f]/.test(input.filename)) {
    return { ok: false, error: "Artifact filename must be a safe single filename" }
  }
  if (!input.filename.toLowerCase().endsWith(".html")) return { ok: false, error: "Artifact filename must end in .html" }
  if (input.mimeType.toLowerCase().split(";")[0] !== "text/html") return { ok: false, error: "Artifact MIME type must be text/html" }
  if (input.bytes.byteLength === 0) return { ok: false, error: "HTML file is empty" }
  if (input.bytes.byteLength > MAX_ARTIFACT_HTML_BYTES) return { ok: false, error: "HTML file exceeds the 2 MB size limit" }
  let html: string
  try {
    html = new TextDecoder("utf-8", { fatal: true }).decode(input.bytes)
  } catch {
    return { ok: false, error: "Artifact content must be valid UTF-8 HTML" }
  }
  const prefix = html.slice(0, 4096).trimStart().toLowerCase()
  if (!prefix.startsWith("<!doctype html") && !prefix.startsWith("<html")) {
    return { ok: false, error: "Artifact content must be a complete HTML document" }
  }
  return { ok: true }
}

export function validateExternalUrl(value: string): string {
  const url = new URL(value)
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("External artifact URL must use http or https")
  if (url.username || url.password) throw new Error("External artifact URL must not contain credentials")
  return url.toString().replace(/\/$/, value.endsWith("/") ? "/" : "")
}

function safeFilename(filename: string): string {
  return filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-180)
}

async function assertWorkspace(workspaceId: string) {
  const workspace = await getPrisma().workspace.findUnique({ where: { id: workspaceId }, select: { id: true } })
  if (!workspace) throw new Error("Workspace not found")
}

export async function createHtmlArtifact(input: {
  workspaceId: string; title: string; description?: string | null; filename: string; mimeType: string;
  bytes: Uint8Array; createdById?: string | null; source: Source
}, storage: ArtifactStorage) {
  const validation = validateHtmlUpload(input)
  if (!validation.ok) throw new Error(validation.error)
  const title = validateArtifactTitle(input.title)
  await assertWorkspace(input.workspaceId)
  const prisma = getPrisma()
  await retryArtifactBlobCleanup(prisma, storage).catch(() => undefined)
  const artifactId = randomUUID()
  const revisionId = randomUUID()
  const pathname = `artifacts/${input.workspaceId}/${artifactId}/${revisionId}-${safeFilename(input.filename)}`
  const stored = await storage.put(pathname, input.bytes)
  try {
    return await prisma.$transaction(async (tx) => {
      const artifact = await tx.artifact.create({ data: {
        id: artifactId, workspaceId: input.workspaceId, title, description: input.description?.trim() || null,
        sourceType: "HTML_UPLOAD", createdById: input.createdById ?? null, updatedById: input.createdById ?? null, source: input.source,
      } })
      const revision = await tx.artifactRevision.create({ data: {
        id: revisionId, artifactId: artifact.id, revisionNumber: 1, blobPathname: stored.pathname,
        filename: input.filename, mimeType: "text/html", byteSize: input.bytes.byteLength,
        sha256: createHash("sha256").update(input.bytes).digest("hex"), createdById: input.createdById ?? null, source: input.source,
      } })
      await tx.artifact.update({ where: { id: artifact.id }, data: { currentRevisionId: revision.id, updatedAt: new Date() } })
      return { ...artifact, currentRevisionId: revision.id }
    })
  } catch (error) {
    await compensateBlob(prisma, storage, stored.pathname, error)
    throw error
  }
}

export async function createExternalArtifact(input: {
  workspaceId: string; title: string; description?: string | null; url: string; createdById?: string | null; source: Source
}) {
  const title = validateArtifactTitle(input.title)
  const externalUrl = validateExternalUrl(input.url)
  await assertWorkspace(input.workspaceId)
  const prisma = getPrisma()
  return prisma.$transaction(async (tx) => {
    const artifact = await tx.artifact.create({ data: {
      workspaceId: input.workspaceId, title, description: input.description?.trim() || null,
      sourceType: "EXTERNAL_LINK", createdById: input.createdById ?? null, updatedById: input.createdById ?? null, source: input.source,
    } })
    const revision = await tx.artifactRevision.create({ data: {
      artifactId: artifact.id, revisionNumber: 1, externalUrl, createdById: input.createdById ?? null, source: input.source,
    } })
    await tx.artifact.update({ where: { id: artifact.id }, data: { currentRevisionId: revision.id, updatedAt: new Date() } })
    return { ...artifact, currentRevisionId: revision.id }
  })
}

export async function replaceHtmlArtifactRevision(input: {
  artifactId: string; workspaceId: string; filename: string; mimeType: string; bytes: Uint8Array;
  createdById?: string | null; source: Source; title?: string; description?: string | null
}, storage: ArtifactStorage) {
  const validation = validateHtmlUpload(input)
  if (!validation.ok) throw new Error(validation.error)
  const title = input.title === undefined ? undefined : validateArtifactTitle(input.title)
  const prisma = getPrisma()
  await retryArtifactBlobCleanup(prisma, storage).catch(() => undefined)
  const artifact = await prisma.artifact.findFirst({ where: { id: input.artifactId, workspaceId: input.workspaceId, sourceType: "HTML_UPLOAD" }, select: { id: true } })
  if (!artifact) throw new Error("Artifact not found")
  const latest = await prisma.artifactRevision.findFirst({ where: { artifactId: artifact.id }, orderBy: { revisionNumber: "desc" }, select: { revisionNumber: true } })
  const revisionNumber = (latest?.revisionNumber ?? 0) + 1
  const revisionId = randomUUID()
  const pathname = `artifacts/${input.workspaceId}/${artifact.id}/${revisionId}-${safeFilename(input.filename)}`
  const stored = await storage.put(pathname, input.bytes)
  try {
    return await prisma.$transaction(async (tx) => {
      const revision = await tx.artifactRevision.create({ data: {
        id: revisionId, artifactId: artifact.id, revisionNumber, blobPathname: stored.pathname,
        filename: input.filename, mimeType: "text/html", byteSize: input.bytes.byteLength,
        sha256: createHash("sha256").update(input.bytes).digest("hex"), createdById: input.createdById ?? null, source: input.source,
      } })
      await tx.artifact.update({ where: { id: artifact.id }, data: {
        currentRevisionId: revision.id,
        ...(title !== undefined ? { title } : {}),
        ...(input.description !== undefined ? { description: input.description?.trim() || null } : {}),
        updatedById: input.createdById ?? null,
        updatedAt: new Date(),
      } })
      return revision
    })
  } catch (error) {
    await compensateBlob(prisma, storage, stored.pathname, error)
    throw error
  }
}

export async function replaceExternalArtifactRevision(input: {
  artifactId: string; workspaceId: string; url: string; createdById?: string | null; source: Source;
  title?: string; description?: string | null
}) {
  const prisma = getPrisma()
  const artifact = await prisma.artifact.findFirst({ where: { id: input.artifactId, workspaceId: input.workspaceId, sourceType: "EXTERNAL_LINK" }, select: { id: true } })
  if (!artifact) throw new Error("Artifact not found")
  const latest = await prisma.artifactRevision.findFirst({ where: { artifactId: artifact.id }, orderBy: { revisionNumber: "desc" }, select: { revisionNumber: true } })
  const externalUrl = validateExternalUrl(input.url)
  const title = input.title === undefined ? undefined : validateArtifactTitle(input.title)
  return prisma.$transaction(async (tx) => {
    const revision = await tx.artifactRevision.create({ data: {
      artifactId: artifact.id, revisionNumber: (latest?.revisionNumber ?? 0) + 1,
      externalUrl, createdById: input.createdById ?? null, source: input.source,
    } })
    await tx.artifact.update({ where: { id: artifact.id }, data: {
      currentRevisionId: revision.id,
      ...(title !== undefined ? { title } : {}),
      ...(input.description !== undefined ? { description: input.description?.trim() || null } : {}),
      updatedById: input.createdById ?? null,
      updatedAt: new Date(),
    } })
    return revision
  })
}

export async function linkArtifactToSolution(input: {
  artifactId: string; solutionId: string; workspaceId: string; createdById?: string | null; source?: Source
}) {
  const prisma = getPrisma()
  const [artifact, solution] = await Promise.all([
    prisma.artifact.findFirst({ where: { id: input.artifactId, workspaceId: input.workspaceId }, select: { id: true, workspaceId: true } }),
    prisma.solution.findFirst({ where: { id: input.solutionId, opportunity: { workspaceId: input.workspaceId } }, select: { id: true } }),
  ])
  if (!artifact || !solution) throw new Error("Artifact and Solution must exist in the same workspace")
  const existing = await prisma.artifactLink.findFirst({ where: { artifactId: artifact.id, linkedType: "SOLUTION", linkedId: solution.id } })
  if (existing) return { ...existing, created: false }
  try {
    const link = await prisma.artifactLink.create({ data: {
      workspaceId: input.workspaceId, artifactId: artifact.id, linkedType: "SOLUTION", linkedId: solution.id,
      createdById: input.createdById ?? null, source: input.source ?? "UI",
    } })
    return { ...link, created: true }
  } catch (error) {
    if ((error as { code?: string }).code !== "P2002") throw error
    const winner = await prisma.artifactLink.findFirst({ where: { artifactId: artifact.id, linkedType: "SOLUTION", linkedId: solution.id } })
    if (!winner) throw error
    return { ...winner, created: false }
  }
}

export async function unlinkArtifactFromSolution(input: { artifactId: string; solutionId: string; workspaceId: string }) {
  const prisma = getPrisma()
  const artifact = await prisma.artifact.findFirst({ where: { id: input.artifactId, workspaceId: input.workspaceId }, select: { id: true } })
  if (!artifact) throw new Error("Artifact not found")
  const link = await prisma.artifactLink.findFirst({ where: { artifactId: input.artifactId, linkedType: "SOLUTION", linkedId: input.solutionId, workspaceId: input.workspaceId } })
  if (!link) return { removed: false }
  await prisma.artifactLink.delete({ where: { id: link.id } })
  return { removed: true }
}

type DecisionArtifactInput = { artifactId: string; requestId: string; workspaceId: string }

async function assertDecisionArtifactTargets(input: DecisionArtifactInput) {
  const prisma = getPrisma()
  const [artifact, request] = await Promise.all([
    prisma.artifact.findFirst({ where: { id: input.artifactId, workspaceId: input.workspaceId }, select: { id: true, status: true } }),
    prisma.reviewRequest.findFirst({ where: { id: input.requestId, workspaceId: input.workspaceId, gateType: "TRACKED_DECISION" }, select: { id: true } }),
  ])
  if (!artifact || !request) throw new Error("Artifact and Decision must exist in the same workspace")
  return artifact
}

function decisionArtifactLinkWhere(input: DecisionArtifactInput) {
  return { workspaceId: input.workspaceId, artifactId: input.artifactId, linkedType: "REVIEW_REQUEST", linkedId: input.requestId }
}

export async function linkArtifactToDecision(input: DecisionArtifactInput & { createdById?: string | null; source?: Source }) {
  const artifact = await assertDecisionArtifactTargets(input)
  const prisma = getPrisma()
  const where = decisionArtifactLinkWhere(input)
  const existing = await prisma.artifactLink.findFirst({ where })
  if (existing) return { ...existing, created: false }
  if (artifact.status === "ARCHIVED") throw new Error("Archived Artifacts cannot be linked to a Decision")
  try {
    const link = await prisma.artifactLink.create({ data: { ...where, createdById: input.createdById ?? null, source: input.source ?? "UI" } })
    return { ...link, created: true }
  } catch (error) {
    if ((error as { code?: string }).code !== "P2002") throw error
    const winner = await prisma.artifactLink.findFirst({ where })
    if (!winner) throw error
    return { ...winner, created: false }
  }
}

export async function unlinkArtifactFromDecision(input: DecisionArtifactInput) {
  await assertDecisionArtifactTargets(input)
  const result = await getPrisma().artifactLink.deleteMany({ where: decisionArtifactLinkWhere(input) })
  return { removed: result.count > 0 }
}

export async function getDecisionArtifacts(workspaceId: string, requestId: string) {
  return getPrisma().artifact.findMany({
    where: { workspaceId, links: { some: { workspaceId, linkedType: "REVIEW_REQUEST", linkedId: requestId } } },
    select: { id: true, title: true, sourceType: true, status: true, currentRevision: { select: { revisionNumber: true } } },
    orderBy: [{ title: "asc" }, { id: "asc" }],
  })
}

export async function getArtifactDecisions(workspaceId: string, artifactId: string) {
  const prisma = getPrisma()
  const links = await prisma.artifactLink.findMany({ where: { workspaceId, artifactId, linkedType: "REVIEW_REQUEST" }, select: { linkedId: true } })
  if (!links.length) return []
  const requests = await prisma.reviewRequest.findMany({
    where: { id: { in: links.map((link) => link.linkedId) }, workspaceId, gateType: "TRACKED_DECISION" },
    select: { id: true, state: true, currentRevision: { select: { title: true } } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  })
  return requests.map((request) => ({ id: request.id, title: request.currentRevision?.title ?? "Decision", state: request.state }))
}

export async function archiveArtifact(input: { artifactId: string; workspaceId: string; updatedById?: string | null }) {
  const prisma = getPrisma()
  const artifact = await prisma.artifact.findFirst({ where: { id: input.artifactId, workspaceId: input.workspaceId }, select: { id: true } })
  if (!artifact) throw new Error("Artifact not found")
  return prisma.artifact.update({ where: { id: artifact.id }, data: { status: "ARCHIVED", updatedById: input.updatedById ?? null, updatedAt: new Date() } })
}

export async function updateArtifactMetadata(input: { artifactId: string; workspaceId: string; title?: string; description?: string | null; updatedById?: string | null }) {
  const prisma = getPrisma()
  const artifact = await prisma.artifact.findFirst({ where: { id: input.artifactId, workspaceId: input.workspaceId }, select: { id: true } })
  if (!artifact) throw new Error("Artifact not found")
  return prisma.artifact.update({ where: { id: artifact.id }, data: {
    ...(input.title !== undefined ? { title: validateArtifactTitle(input.title) } : {}),
    ...(input.description !== undefined ? { description: input.description?.trim() || null } : {}),
    updatedById: input.updatedById ?? null, updatedAt: new Date(),
  } })
}

async function enqueueBlobCleanup(
  prisma: { artifactBlobCleanup: Pick<ReturnType<typeof getPrisma>["artifactBlobCleanup"], "upsert"> },
  pathnames: string[],
  reason: string
) {
  for (const blobPathname of new Set(pathnames)) {
    await prisma.artifactBlobCleanup.upsert({
      where: { blobPathname },
      create: { blobPathname, reason },
      update: { reason, updatedAt: new Date() },
    })
  }
}

async function compensateBlob(
  prisma: { artifactBlobCleanup: Pick<ReturnType<typeof getPrisma>["artifactBlobCleanup"], "upsert"> },
  storage: ArtifactStorage,
  pathname: string,
  originalError: unknown
) {
  try {
    await storage.del(pathname)
  } catch (deleteError) {
    try {
      await enqueueBlobCleanup(prisma, [pathname], "FAILED_WRITE")
    } catch (outboxError) {
      throw new AggregateError(
        [originalError, deleteError, outboxError],
        "Artifact write failed and Blob cleanup could not be persisted"
      )
    }
  }
}

export async function retryArtifactBlobCleanup(
  prisma: {
    artifactBlobCleanup: Pick<ReturnType<typeof getPrisma>["artifactBlobCleanup"], "findMany" | "update" | "delete">
    artifactRevision: Pick<ReturnType<typeof getPrisma>["artifactRevision"], "findFirst">
  },
  storage: ArtifactStorage,
  onlyPathnames?: string[]
) {
  const rows = await prisma.artifactBlobCleanup.findMany({
    where: onlyPathnames ? { blobPathname: { in: onlyPathnames } } : {},
    orderBy: { createdAt: "asc" },
    take: 50,
  })
  for (const row of rows) {
    const stillReferenced = await prisma.artifactRevision.findFirst({
      where: { blobPathname: row.blobPathname }, select: { id: true },
    })
    if (stillReferenced) continue
    try {
      await storage.del(row.blobPathname)
      await prisma.artifactBlobCleanup.delete({ where: { id: row.id } })
    } catch (error) {
      await prisma.artifactBlobCleanup.update({
        where: { id: row.id },
        data: {
          attempts: row.attempts + 1,
          lastError: error instanceof Error ? error.message.slice(0, 1000) : "Blob deletion failed",
          updatedAt: new Date(),
        },
      })
    }
  }
}

export function toArtifactDetailDto(artifact: {
  id: string
  title: string
  description: string | null
  sourceType: string
  status: string
  currentRevision: { externalUrl: string | null; blobPathname?: string | null } | null
  revisions: Array<{
    id: string; revisionNumber: number; filename: string | null; byteSize: number | null;
    externalUrl: string | null; blobPathname?: string | null; createdAt: Date
  }>
}) {
  return {
    id: artifact.id,
    title: artifact.title,
    description: artifact.description,
    sourceType: artifact.sourceType,
    status: artifact.status,
    currentRevision: artifact.currentRevision ? { externalUrl: artifact.currentRevision.externalUrl } : null,
    revisions: artifact.revisions.map((revision) => ({
      id: revision.id,
      revisionNumber: revision.revisionNumber,
      filename: revision.filename,
      byteSize: revision.byteSize,
      externalUrl: revision.externalUrl,
      createdAt: revision.createdAt.toISOString(),
    })),
  }
}

export async function deleteArtifact(input: { artifactId: string; workspaceId: string }, storage: ArtifactStorage) {
  const prisma = getPrisma()
  const artifact = await prisma.artifact.findFirst({ where: { id: input.artifactId, workspaceId: input.workspaceId }, include: { revisions: { select: { blobPathname: true } } } })
  if (!artifact) throw new Error("Artifact not found")
  const pathnames = artifact.revisions.flatMap((revision) => revision.blobPathname ? [revision.blobPathname] : [])
  await enqueueBlobCleanup(prisma, pathnames, "ARTIFACT_DELETE")
  await prisma.artifactLink.deleteMany({ where: { artifactId: artifact.id } })
  await prisma.artifact.update({ where: { id: artifact.id }, data: { currentRevisionId: null, updatedAt: new Date() } })
  await prisma.artifactRevision.deleteMany({ where: { artifactId: artifact.id } })
  await prisma.artifact.delete({ where: { id: artifact.id } })
  await retryArtifactBlobCleanup(prisma, storage)
}

type PrismaClient = ReturnType<typeof getPrisma>
type WorkspaceArtifactCleanupClient = {
  artifact: Pick<PrismaClient["artifact"], "findMany" | "updateMany" | "deleteMany">
  artifactRevision: Pick<PrismaClient["artifactRevision"], "findMany" | "findFirst" | "deleteMany">
  artifactLink: Pick<PrismaClient["artifactLink"], "deleteMany">
  artifactBlobCleanup: Pick<PrismaClient["artifactBlobCleanup"], "upsert" | "findMany" | "update" | "delete">
}

/** Removes every Artifact child row before its workspace in the explicit order
 * required by DSQL, then best-effort removes the now-unreferenced private blobs. */
export async function deleteWorkspaceArtifacts(
  prisma: WorkspaceArtifactCleanupClient,
  workspaceId: string,
  storage: ArtifactStorage,
  retryCleanup = true
) {
  const artifacts = await prisma.artifact.findMany({ where: { workspaceId }, select: { id: true } })
  const artifactIds = artifacts.map((artifact) => artifact.id)
  const revisions = artifactIds.length === 0 ? [] : await prisma.artifactRevision.findMany({
    where: { artifactId: { in: artifactIds } }, select: { blobPathname: true },
  })
  const pathnames = revisions.flatMap((revision) => revision.blobPathname ? [revision.blobPathname] : [])
  await enqueueBlobCleanup(prisma, pathnames, "WORKSPACE_DELETE")
  await prisma.artifactLink.deleteMany({ where: { workspaceId } })
  await prisma.artifact.updateMany({ where: { workspaceId }, data: { currentRevisionId: null, updatedAt: new Date() } })
  if (artifactIds.length > 0) {
    await prisma.artifactRevision.deleteMany({ where: { artifactId: { in: artifactIds } } })
  }
  await prisma.artifact.deleteMany({ where: { workspaceId } })
  if (retryCleanup) await retryArtifactBlobCleanup(prisma, storage)
}
