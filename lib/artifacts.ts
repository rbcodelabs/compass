import { createHash, randomUUID } from "node:crypto"
import getPrisma from "@/lib/db"
import type { ArtifactStorage } from "@/lib/artifact-storage"

export const MAX_ARTIFACT_HTML_BYTES = 2 * 1024 * 1024
export const ARTIFACT_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' blob:",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data: blob:",
  "media-src data: blob:",
  "connect-src 'none'",
  "form-action 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "manifest-src 'none'",
].join("; ")

type Source = "UI" | "MCP"

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

export function buildSandboxedHtml(html: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${ARTIFACT_CSP}"><meta name="referrer" content="no-referrer">`
  return `${meta}${html}`
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
  await assertWorkspace(input.workspaceId)
  const prisma = getPrisma()
  const artifact = await prisma.artifact.create({ data: {
    workspaceId: input.workspaceId, title: input.title.trim(), description: input.description?.trim() || null,
    sourceType: "HTML_UPLOAD", createdById: input.createdById ?? null, updatedById: input.createdById ?? null, source: input.source,
  } })
  const revisionId = randomUUID()
  const pathname = `artifacts/${input.workspaceId}/${artifact.id}/${revisionId}-${safeFilename(input.filename)}`
  let storedPath: string | null = null
  try {
    storedPath = (await storage.put(pathname, input.bytes)).pathname
    const revision = await prisma.artifactRevision.create({ data: {
      id: revisionId, artifactId: artifact.id, revisionNumber: 1, blobPathname: storedPath,
      filename: input.filename, mimeType: "text/html", byteSize: input.bytes.byteLength,
      sha256: createHash("sha256").update(input.bytes).digest("hex"), createdById: input.createdById ?? null, source: input.source,
    } })
    await prisma.artifact.update({ where: { id: artifact.id }, data: { currentRevisionId: revision.id, updatedAt: new Date() } })
    return { ...artifact, currentRevisionId: revision.id }
  } catch (error) {
    if (storedPath) await storage.del(storedPath).catch(() => undefined)
    await prisma.artifactRevision.deleteMany({ where: { artifactId: artifact.id } }).catch(() => undefined)
    await prisma.artifact.delete({ where: { id: artifact.id } }).catch(() => undefined)
    throw error
  }
}

export async function createExternalArtifact(input: {
  workspaceId: string; title: string; description?: string | null; url: string; createdById?: string | null; source: Source
}) {
  await assertWorkspace(input.workspaceId)
  const prisma = getPrisma()
  const externalUrl = validateExternalUrl(input.url)
  const artifact = await prisma.artifact.create({ data: {
    workspaceId: input.workspaceId, title: input.title.trim(), description: input.description?.trim() || null,
    sourceType: "EXTERNAL_LINK", createdById: input.createdById ?? null, updatedById: input.createdById ?? null, source: input.source,
  } })
  try {
    const revision = await prisma.artifactRevision.create({ data: {
      artifactId: artifact.id, revisionNumber: 1, externalUrl, createdById: input.createdById ?? null, source: input.source,
    } })
    await prisma.artifact.update({ where: { id: artifact.id }, data: { currentRevisionId: revision.id, updatedAt: new Date() } })
    return { ...artifact, currentRevisionId: revision.id }
  } catch (error) {
    await prisma.artifact.delete({ where: { id: artifact.id } }).catch(() => undefined)
    throw error
  }
}

export async function replaceHtmlArtifactRevision(input: {
  artifactId: string; workspaceId: string; filename: string; mimeType: string; bytes: Uint8Array;
  createdById?: string | null; source: Source
}, storage: ArtifactStorage) {
  const validation = validateHtmlUpload(input)
  if (!validation.ok) throw new Error(validation.error)
  const prisma = getPrisma()
  const artifact = await prisma.artifact.findFirst({ where: { id: input.artifactId, workspaceId: input.workspaceId, sourceType: "HTML_UPLOAD" }, select: { id: true } })
  if (!artifact) throw new Error("Artifact not found")
  const latest = await prisma.artifactRevision.findFirst({ where: { artifactId: artifact.id }, orderBy: { revisionNumber: "desc" }, select: { revisionNumber: true } })
  const revisionNumber = (latest?.revisionNumber ?? 0) + 1
  const revisionId = randomUUID()
  const pathname = `artifacts/${input.workspaceId}/${artifact.id}/${revisionId}-${safeFilename(input.filename)}`
  const stored = await storage.put(pathname, input.bytes)
  try {
    const revision = await prisma.artifactRevision.create({ data: {
      id: revisionId, artifactId: artifact.id, revisionNumber, blobPathname: stored.pathname,
      filename: input.filename, mimeType: "text/html", byteSize: input.bytes.byteLength,
      sha256: createHash("sha256").update(input.bytes).digest("hex"), createdById: input.createdById ?? null, source: input.source,
    } })
    await prisma.artifact.update({ where: { id: artifact.id }, data: { currentRevisionId: revision.id, updatedById: input.createdById ?? null, updatedAt: new Date() } })
    return revision
  } catch (error) {
    await storage.del(stored.pathname).catch(() => undefined)
    throw error
  }
}

export async function replaceExternalArtifactRevision(input: {
  artifactId: string; workspaceId: string; url: string; createdById?: string | null; source: Source
}) {
  const prisma = getPrisma()
  const artifact = await prisma.artifact.findFirst({ where: { id: input.artifactId, workspaceId: input.workspaceId, sourceType: "EXTERNAL_LINK" }, select: { id: true } })
  if (!artifact) throw new Error("Artifact not found")
  const latest = await prisma.artifactRevision.findFirst({ where: { artifactId: artifact.id }, orderBy: { revisionNumber: "desc" }, select: { revisionNumber: true } })
  const revision = await prisma.artifactRevision.create({ data: {
    artifactId: artifact.id, revisionNumber: (latest?.revisionNumber ?? 0) + 1,
    externalUrl: validateExternalUrl(input.url), createdById: input.createdById ?? null, source: input.source,
  } })
  await prisma.artifact.update({ where: { id: artifact.id }, data: { currentRevisionId: revision.id, updatedById: input.createdById ?? null, updatedAt: new Date() } })
  return revision
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
  const link = await prisma.artifactLink.create({ data: {
    workspaceId: input.workspaceId, artifactId: artifact.id, linkedType: "SOLUTION", linkedId: solution.id,
    createdById: input.createdById ?? null, source: input.source ?? "UI",
  } })
  return { ...link, created: true }
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
    ...(input.title !== undefined ? { title: input.title.trim() } : {}),
    ...(input.description !== undefined ? { description: input.description?.trim() || null } : {}),
    updatedById: input.updatedById ?? null, updatedAt: new Date(),
  } })
}

export async function deleteArtifact(input: { artifactId: string; workspaceId: string }, storage: ArtifactStorage) {
  const prisma = getPrisma()
  const artifact = await prisma.artifact.findFirst({ where: { id: input.artifactId, workspaceId: input.workspaceId }, include: { revisions: { select: { blobPathname: true } } } })
  if (!artifact) throw new Error("Artifact not found")
  await prisma.artifactLink.deleteMany({ where: { artifactId: artifact.id } })
  await prisma.artifact.update({ where: { id: artifact.id }, data: { currentRevisionId: null, updatedAt: new Date() } })
  await prisma.artifactRevision.deleteMany({ where: { artifactId: artifact.id } })
  await prisma.artifact.delete({ where: { id: artifact.id } })
  await Promise.all(artifact.revisions.flatMap((revision) => revision.blobPathname ? [storage.del(revision.blobPathname)] : []))
}

type PrismaClient = ReturnType<typeof getPrisma>
type WorkspaceArtifactCleanupClient = {
  artifact: Pick<PrismaClient["artifact"], "findMany" | "updateMany" | "deleteMany">
  artifactRevision: Pick<PrismaClient["artifactRevision"], "findMany" | "deleteMany">
  artifactLink: Pick<PrismaClient["artifactLink"], "deleteMany">
}

/** Removes every Artifact child row before its workspace in the explicit order
 * required by DSQL, then best-effort removes the now-unreferenced private blobs. */
export async function deleteWorkspaceArtifacts(
  prisma: WorkspaceArtifactCleanupClient,
  workspaceId: string,
  storage: ArtifactStorage
) {
  const artifacts = await prisma.artifact.findMany({ where: { workspaceId }, select: { id: true } })
  const artifactIds = artifacts.map((artifact) => artifact.id)
  const revisions = artifactIds.length === 0 ? [] : await prisma.artifactRevision.findMany({
    where: { artifactId: { in: artifactIds } }, select: { blobPathname: true },
  })
  await prisma.artifactLink.deleteMany({ where: { workspaceId } })
  await prisma.artifact.updateMany({ where: { workspaceId }, data: { currentRevisionId: null, updatedAt: new Date() } })
  if (artifactIds.length > 0) {
    await prisma.artifactRevision.deleteMany({ where: { artifactId: { in: artifactIds } } })
  }
  await prisma.artifact.deleteMany({ where: { workspaceId } })
  await Promise.allSettled(revisions.flatMap((revision) =>
    revision.blobPathname ? [storage.del(revision.blobPathname)] : []
  ))
}
