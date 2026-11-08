import getPrisma from "@/lib/db"
import { agentWorkspaceWhere } from "@/lib/agent-access"
import { assertWorkspaceMember, isResearchActor, McpAuthzError, type McpActor } from "@/lib/mcp-authz"
import { getArtifactStorage, type ArtifactStorage } from "@/lib/artifact-storage"
import { readArtifactKind } from "@/lib/artifact-kind"
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js"

/** Largest artifact body returned inline over MCP; bigger ones are refused, not truncated. */
export const MAX_ARTIFACT_RESOURCE_BYTES = 5 * 1024 * 1024

/**
 * Largest text window per read, in characters (UTF-16 code units of the decoded text).
 * A host proxy truncates any single result at 100,000 chars; 90,000 leaves headroom for
 * JSON escaping and the _meta envelope. Heavily quote/backslash-laden bodies can still
 * expand past the cap when escaped - pass a smaller `length` for those.
 */
export const MAX_ARTIFACT_TEXT_WINDOW_CHARS = 90_000
/** Largest blob window per read, in bytes: 60,000 bytes is 80,000 base64 chars. Multiple of 3 so chunks concatenate cleanly. */
export const MAX_ARTIFACT_BLOB_WINDOW_BYTES = 60_000
const BASE64_GROUP_BYTES = 3

export type ArtifactReadRange = { offset?: number; length?: number }

export type ArtifactResourceIds = { workspaceId: string; artifactId: string; revisionId?: string }

export function artifactResourceUri(ids: ArtifactResourceIds): string {
  const base = `artifact://${ids.workspaceId}/${ids.artifactId}`
  return ids.revisionId ? `${base}/${ids.revisionId}` : base
}

function parseNonNegativeInt(name: string, raw: string, min: number): number {
  if (!/^\d{1,15}$/.test(raw)) throw new Error(`Invalid "${name}": expected a whole number >= ${min}, got "${raw}".`)
  const value = Number(raw)
  if (value < min) throw new Error(`Invalid "${name}": must be >= ${min}, got ${value}.`)
  return value
}

/** Parses `?offset=N&length=M` (the only accepted keys). Throws a clear error on anything else. */
export function parseArtifactReadRange(search: string): ArtifactReadRange {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search)
  const range: ArtifactReadRange = {}
  for (const key of new Set(params.keys())) {
    if (key !== "offset" && key !== "length") throw new Error(`Unknown query parameter "${key}". Supported: offset, length.`)
    const values = params.getAll(key)
    if (values.length > 1) throw new Error(`Query parameter "${key}" was given more than once.`)
    if (key === "offset") range.offset = parseNonNegativeInt("offset", values[0], 0)
    else range.length = parseNonNegativeInt("length", values[0], 1)
  }
  return range
}

/**
 * The SDK's UriTemplate lets the last `{var}` swallow a trailing `?query` (it matches
 * `[^/,]+`), so `artifact://ws/art?offset=1` arrives with artifactId "art?offset=1".
 * Split the query back off here; the ids are the part before the first `?`.
 */
export function parseArtifactResourceRequest(
  variables: Record<string, string | string[] | undefined>
): { ids: ArtifactResourceIds; range: ArtifactReadRange } {
  const raw = (name: string): string | undefined => {
    const value = variables[name]
    const first = Array.isArray(value) ? value[0] : value
    return first === undefined ? undefined : String(first)
  }
  const split = (value: string | undefined): { head: string; search: string } => {
    const at = (value ?? "").indexOf("?")
    return at === -1 ? { head: value ?? "", search: "" } : { head: value!.slice(0, at), search: value!.slice(at) }
  }
  const decode = (value: string): string => {
    try {
      return decodeURIComponent(value)
    } catch {
      throw new Error("Malformed artifact URI: invalid percent-encoding.")
    }
  }
  const artifact = split(raw("artifactId"))
  const revision = split(raw("revisionId"))
  const search = artifact.search || revision.search
  return {
    ids: {
      workspaceId: decode(raw("workspaceId") ?? ""),
      artifactId: decode(artifact.head),
      ...(raw("revisionId") !== undefined ? { revisionId: decode(revision.head) } : {}),
    },
    range: parseArtifactReadRange(search),
  }
}

type Window = { content: string; offset: number; length: number; total: number; nextOffset: number | null }

function isHighSurrogate(code: number) {
  return code >= 0xd800 && code <= 0xdbff
}
function isLowSurrogate(code: number) {
  return code >= 0xdc00 && code <= 0xdfff
}

function sliceText(text: string, range: ArtifactReadRange): Window {
  const total = text.length
  const offset = range.offset ?? 0
  if (offset > total) throw new Error(`Invalid "offset": ${offset} is past the end of the content (${total} chars).`)
  if (offset < total && offset > 0 && isLowSurrogate(text.charCodeAt(offset)) && isHighSurrogate(text.charCodeAt(offset - 1))) {
    throw new Error(`Invalid "offset": ${offset} splits a surrogate pair. Use the nextOffset from the previous read.`)
  }
  let end = Math.min(total, offset + Math.min(range.length ?? MAX_ARTIFACT_TEXT_WINDOW_CHARS, MAX_ARTIFACT_TEXT_WINDOW_CHARS))
  if (end < total && isHighSurrogate(text.charCodeAt(end - 1))) end = end - 1 > offset ? end - 1 : end + 1
  return { content: text.slice(offset, end), offset, length: end - offset, total, nextOffset: end < total ? end : null }
}

function sliceBytes(bytes: Uint8Array, range: ArtifactReadRange): Window {
  const total = bytes.byteLength
  const offset = range.offset ?? 0
  if (offset > total) throw new Error(`Invalid "offset": ${offset} is past the end of the content (${total} bytes).`)
  if (offset !== total && offset % BASE64_GROUP_BYTES !== 0) {
    throw new Error(`Invalid "offset": ${offset} must be a multiple of ${BASE64_GROUP_BYTES} bytes for binary content so base64 chunks concatenate. Use the nextOffset from the previous read.`)
  }
  const requested = Math.min(range.length ?? MAX_ARTIFACT_BLOB_WINDOW_BYTES, MAX_ARTIFACT_BLOB_WINDOW_BYTES)
  const aligned = Math.max(BASE64_GROUP_BYTES, requested - (requested % BASE64_GROUP_BYTES))
  const end = Math.min(total, offset + aligned)
  return {
    content: Buffer.from(bytes.subarray(offset, end)).toString("base64"),
    offset,
    length: end - offset,
    total,
    nextOffset: end < total ? end : null,
  }
}

function windowMeta(window: Window, unit: "chars" | "bytes", baseUri: string) {
  return {
    totalLength: window.total,
    offset: window.offset,
    length: window.length,
    nextOffset: window.nextOffset,
    truncated: window.nextOffset !== null,
    unit,
    ...(window.nextOffset !== null
      ? { hint: `partial: showing ${unit} ${window.offset}-${window.offset + window.length} of ${window.total}; re-read ${baseUri}?offset=${window.nextOffset} for the next page` }
      : {}),
  }
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
  options: { storage?: ArtifactStorage; range?: ArtifactReadRange } = {}
) {
  const range = options.range ?? {}
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
    const window = sliceText(revision.externalUrl, range)
    return { contents: [{ uri, text: window.content, mimeType: "text/uri-list", _meta: { ..._meta, ...windowMeta(window, "chars", uri) } }] }
  }

  const tooLarge = () =>
    new Error(`Artifact content is larger than the ${MAX_ARTIFACT_RESOURCE_BYTES / (1024 * 1024)} MiB resource limit and cannot be read over MCP.`)
  if (revision.byteSize != null && revision.byteSize > MAX_ARTIFACT_RESOURCE_BYTES) throw tooLarge()
  const bytes = await (options.storage ?? getArtifactStorage()).get(revision.blobPathname)
  if (!bytes) throw new Error(`Content for revision "${revision.id}" is missing from storage.`)
  if (bytes.byteLength > MAX_ARTIFACT_RESOURCE_BYTES) throw tooLarge()

  const mimeType = revision.mimeType ?? "application/octet-stream"
  if (isTextMime(mimeType)) {
    const window = sliceText(new TextDecoder().decode(bytes), range)
    return { contents: [{ uri, text: window.content, mimeType, _meta: { ..._meta, ...windowMeta(window, "chars", uri) } }] }
  }
  const window = sliceBytes(bytes, range)
  return { contents: [{ uri, blob: window.content, mimeType, _meta: { ..._meta, ...windowMeta(window, "bytes", uri) } }] }
}

export const ARTIFACT_PAGING_DESCRIPTION =
  `Reads are paged: add ?offset=N&length=M to the URI (e.g. artifact://{workspaceId}/{artifactId}?offset=90000). ` +
  `Each read returns at most ${MAX_ARTIFACT_TEXT_WINDOW_CHARS.toLocaleString("en-US")} characters of text (offsets in characters; a surrogate pair is never split) ` +
  `or ${MAX_ARTIFACT_BLOB_WINDOW_BYTES.toLocaleString("en-US")} bytes of a binary blob (offsets in bytes, multiples of ${BASE64_GROUP_BYTES}; concatenate the base64 chunks' decoded bytes). ` +
  `Without a range you get the first page. _meta reports totalLength, offset, length, nextOffset (null when finished), truncated, unit and a hint: loop until nextOffset is null.`

/** Registers the artifact:// resources. Two templates because the SDK's UriTemplate cannot match an optional trailing segment. */
export function registerArtifactResources(server: McpServer, getActor: () => McpActor): void {
  const meta = {
    title: "Compass Artifact",
    description:
      "Content of a Compass Artifact. HTML is returned as text; other uploads as base64 blob; EXTERNAL_LINK and V0_CHAT " +
      "artifacts return their URL as text/uri-list. _meta carries artifactId, revisionId, kind and sha256. Total artifact size capped at 5 MiB. " +
      ARTIFACT_PAGING_DESCRIPTION,
  }
  server.registerResource(
    "artifact",
    new ResourceTemplate("artifact://{workspaceId}/{artifactId}", { list: async () => listArtifactResources(getActor()) }),
    meta,
    async (_uri, variables) => {
      const { ids, range } = parseArtifactResourceRequest(variables)
      return readArtifactResource(getActor(), ids, { range })
    }
  )
  server.registerResource(
    "artifact-revision",
    new ResourceTemplate("artifact://{workspaceId}/{artifactId}/{revisionId}", { list: undefined }),
    { ...meta, title: "Compass Artifact Revision" },
    async (_uri, variables) => {
      const { ids, range } = parseArtifactResourceRequest(variables)
      return readArtifactResource(getActor(), ids, { range })
    }
  )
}
