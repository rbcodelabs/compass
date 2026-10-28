import getPrisma from "@/lib/db"
import { agentWorkspaceWhere } from "@/lib/agent-access"
import { assertWorkspaceMember, isResearchActor, McpAuthzError, type McpActor } from "@/lib/mcp-authz"
import { getArtifactStorage, type ArtifactStorage } from "@/lib/artifact-storage"
import { readArtifactKind } from "@/lib/artifact-kind"

/** Largest artifact body returned inline over MCP; bigger ones are refused, not truncated. */
export const MAX_ARTIFACT_RESOURCE_BYTES = 5 * 1024 * 1024

export type ArtifactResourceIds = { workspaceId: string; artifactId: string; revisionId?: string }

export function artifactResourceUri(ids: ArtifactResourceIds): string {
  const base = `artifact://${ids.workspaceId}/${ids.artifactId}`
  return ids.revisionId ? `${base}/${ids.revisionId}` : base
}

function denyResearch(actor: McpActor): void {
  if (isResearchActor(actor)) throw new McpAuthzError("Resource is not available to research interviews.")
}

function isTextMime(mimeType: string): boolean {
  const base = mimeType.split(";")[0].trim().toLowerCase()
  return (
    base.startsWith("text/") ||
    base === "application/json" ||
    base === "application/xml" ||
    base === "application/javascript" ||
    base.endsWith("+json") ||
    base.endsWith("+xml")
  )
}

export async function listArtifactResources(actor: McpActor) {
  denyResearch(actor)
  const prisma = getPrisma()
  const workspaces = await prisma.workspace.findMany({ where: await agentWorkspaceWhere(actor), select: { id: true } })
  if (workspaces.length === 0) return { resources: [] }
  const artifacts = await prisma.artifact.findMany({
    where: { workspaceId: { in: workspaces.map((w) => w.id) }, status: { not: "ARCHIVED" }, currentRevisionId: { not: null } },
    select: { id: true, workspaceId: true, title: true, currentRevision: { select: { mimeType: true } } },
    orderBy: { updatedAt: "desc" },
  })
  return {
    resources: artifacts.map((artifact) => ({
      uri: artifactResourceUri({ workspaceId: artifact.workspaceId, artifactId: artifact.id }),
      name: artifact.title,
      mimeType: artifact.currentRevision?.mimeType ?? "text/uri-list",
    })),
  }
}

export async function readArtifactResource(
  actor: McpActor,
  ids: ArtifactResourceIds,
  options: { storage?: ArtifactStorage } = {}
) {
  denyResearch(actor)
  // Membership first, then a workspace-scoped lookup: a non-member gets the same
  // denial whether or not the artifact exists.
  await assertWorkspaceMember(actor, ids.workspaceId)
  const prisma = getPrisma()
  const artifact = await prisma.artifact.findFirst({
    where: { id: ids.artifactId, workspaceId: ids.workspaceId },
    select: { id: true, kind: true, sourceType: true, currentRevisionId: true },
  })
  if (!artifact) throw new Error(`Artifact "${ids.artifactId}" not found in this workspace.`)
  const revisionId = ids.revisionId ?? artifact.currentRevisionId
  if (!revisionId) throw new Error(`Artifact "${ids.artifactId}" has no revisions.`)
  const revision = await prisma.artifactRevision.findFirst({
    where: { id: revisionId, artifactId: artifact.id },
    select: { id: true, blobPathname: true, mimeType: true, filename: true, byteSize: true, sha256: true, externalUrl: true },
  })
  if (!revision) throw new Error(`Revision "${revisionId}" not found on artifact "${artifact.id}".`)

  const uri = artifactResourceUri({ workspaceId: ids.workspaceId, artifactId: artifact.id, revisionId: revision.id })
  const _meta = {
    artifactId: artifact.id,
    revisionId: revision.id,
    kind: readArtifactKind(artifact.kind),
    sourceType: artifact.sourceType,
    sha256: revision.sha256,
    filename: revision.filename,
  }

  if (!revision.blobPathname) {
    if (!revision.externalUrl) throw new Error(`Revision "${revision.id}" has no readable content.`)
    return { contents: [{ uri, text: revision.externalUrl, mimeType: "text/uri-list", _meta }] }
  }

  const tooLarge = () =>
    new Error(`Artifact content is larger than the ${MAX_ARTIFACT_RESOURCE_BYTES / (1024 * 1024)} MiB resource limit and cannot be read over MCP.`)
  if (revision.byteSize != null && revision.byteSize > MAX_ARTIFACT_RESOURCE_BYTES) throw tooLarge()
  const bytes = await (options.storage ?? getArtifactStorage()).get(revision.blobPathname)
  if (!bytes) throw new Error(`Content for revision "${revision.id}" is missing from storage.`)
  if (bytes.byteLength > MAX_ARTIFACT_RESOURCE_BYTES) throw tooLarge()

  const mimeType = revision.mimeType ?? "application/octet-stream"
  return isTextMime(mimeType)
    ? { contents: [{ uri, text: new TextDecoder().decode(bytes), mimeType, _meta }] }
    : { contents: [{ uri, blob: Buffer.from(bytes).toString("base64"), mimeType, _meta }] }
}
