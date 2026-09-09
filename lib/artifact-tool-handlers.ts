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

export async function listArtifacts({ workspaceId, includeArchived = false }: { workspaceId: string; includeArchived?: boolean }) {
  const artifacts = await getPrisma().artifact.findMany({
    where: { workspaceId, ...(includeArchived ? {} : { status: "ACTIVE" }) },
    include: { currentRevision: { select: { revisionNumber: true, filename: true, externalUrl: true } }, _count: { select: { revisions: true, links: true } } },
    orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
  })
  return ok(`${artifacts.length} artifact${artifacts.length === 1 ? "" : "s"} found.`, { items: artifacts, count: artifacts.length })
}

export async function getArtifact({ artifactId }: { artifactId: string }) {
  const prisma = getPrisma()
  const artifact = await prisma.artifact.findUnique({ where: { id: artifactId }, include: { currentRevision: true, revisions: { orderBy: { revisionNumber: "desc" } }, links: { where: { linkedType: "SOLUTION" } } } })
  if (!artifact) return fail(`Artifact "${artifactId}" not found.`)
  const solutions = artifact.links.length ? await prisma.solution.findMany({ where: { id: { in: artifact.links.map((link) => link.linkedId) }, opportunity: { workspaceId: artifact.workspaceId } }, select: { id: true, title: true } }) : []
  const decisions = await getArtifactDecisions(artifact.workspaceId, artifact.id)
  const safeRevisions = artifact.revisions.map(({ blobPathname: _privatePath, ...revision }) => revision)
  const text = [`# ${artifact.title}`, `ID: ${artifact.id}`, `Type: ${artifact.sourceType}`, `Status: ${artifact.status}`, `Current revision: ${artifact.currentRevision?.revisionNumber ?? "None"}`, `Linked solutions: ${solutions.map((solution) => `${solution.title} (${solution.id})`).join(", ") || "None"}`].join("\n")
  return ok(`${text}\nLinked decisions: ${decisions.map((decision) => `${decision.title} (${decision.id})`).join(", ") || "None"}`, { ...artifact, currentRevision: artifact.currentRevision ? { ...artifact.currentRevision, blobPathname: undefined } : null, revisions: safeRevisions, solutions, decisions, links: undefined })
}

export async function createArtifact(input: { workspaceId: string; title: string; description?: string; sourceType: "HTML_UPLOAD" | "EXTERNAL_LINK"; html?: string; filename?: string; url?: string }) {
  try {
    validateArtifactTitle(input.title)
    if (input.sourceType === "HTML_UPLOAD" && (input.url !== undefined || input.html === undefined)) {
      return fail("HTML_UPLOAD requires html and does not accept url.")
    }
    if (input.sourceType === "EXTERNAL_LINK" && (input.html !== undefined || input.filename !== undefined || input.url === undefined)) {
      return fail("EXTERNAL_LINK requires url and does not accept html or filename.")
    }
    const artifact = input.sourceType === "HTML_UPLOAD"
      ? await createHtmlArtifact({ workspaceId: input.workspaceId, title: input.title, description: input.description, filename: input.filename ?? "prototype.html", mimeType: "text/html", bytes: new TextEncoder().encode(input.html ?? ""), source: "MCP" }, getArtifactStorage())
      : await createExternalArtifact({ workspaceId: input.workspaceId, title: input.title, description: input.description, url: input.url ?? "", source: "MCP" })
    return ok(`Artifact created.\nID: ${artifact.id}`, { id: artifact.id, title: artifact.title, sourceType: input.sourceType })
  } catch (error) { return fail(error instanceof Error ? error.message : "Could not create artifact") }
}

export async function updateArtifact(input: { artifactId: string; workspaceId: string; title?: string; description?: string | null; html?: string; filename?: string; url?: string }) {
  try {
    if (input.html !== undefined && input.url !== undefined) return fail("Provide either html or url, not both.")
    if (input.title !== undefined) validateArtifactTitle(input.title)
    const prisma = getPrisma()
    const existing = await prisma.artifact.findFirst({ where: { id: input.artifactId, workspaceId: input.workspaceId }, select: { id: true, sourceType: true } })
    if (!existing) return fail(`Artifact "${input.artifactId}" not found.`)
    if (existing.sourceType === "HTML_UPLOAD" && input.url !== undefined) return fail("HTML_UPLOAD artifacts accept html revisions, not url.")
    if (existing.sourceType === "EXTERNAL_LINK" && (input.html !== undefined || input.filename !== undefined)) return fail("EXTERNAL_LINK artifacts accept url revisions, not html or filename.")
    if (input.filename !== undefined && input.html === undefined) return fail("filename requires html.")
    if (input.html !== undefined) {
      const validation = validateHtmlUpload({ filename: input.filename ?? "prototype.html", mimeType: "text/html", bytes: new TextEncoder().encode(input.html) })
      if (!validation.ok) return fail(validation.error)
    }
    if (input.url !== undefined) validateExternalUrl(input.url)
    let revisionId: string | undefined
    if (input.html !== undefined) revisionId = (await replaceHtmlArtifactRevision({ artifactId: input.artifactId, workspaceId: input.workspaceId, filename: input.filename ?? "prototype.html", mimeType: "text/html", bytes: new TextEncoder().encode(input.html), title: input.title, description: input.description, source: "MCP" }, getArtifactStorage())).id
    else if (input.url !== undefined) revisionId = (await replaceExternalArtifactRevision({ artifactId: input.artifactId, workspaceId: input.workspaceId, url: input.url, title: input.title, description: input.description, source: "MCP" })).id
    else if (input.title !== undefined || input.description !== undefined) await updateArtifactMetadata(input)
    return ok(`Artifact updated.\nID: ${input.artifactId}`, { id: input.artifactId, revisionId })
  } catch (error) { return fail(error instanceof Error ? error.message : "Could not update artifact") }
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
