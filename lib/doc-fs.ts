/**
 * Docs as a virtual filesystem — path-addressed operations over the existing
 * Doc/DocVersion Prisma models. See ADR 0019 (Compass Doc
 * b7a5fb07-3a3d-48db-a8db-f492a25ec2d2) and the companion implementation spec,
 * docs/design/docs-virtual-filesystem-mcp.md.
 *
 * This is a VIEW over lib/document-service.ts's existing id-addressed mutation
 * functions (createDocument/updateDocument/deleteDocument/hydrateDocument) — it
 * adds no second copy of the idempotency (DocOperation receipts) or optimistic
 * concurrency (expectedRevision) machinery those already own. That is also why
 * this module works unchanged whether a Doc's content lives in the DB `content`
 * column or behind the Geode pilot's blob reference: the storage-provider
 * branch already lives in document-service.ts, not here.
 *
 * Path encoding (spec §1.1): a path segment is the doc's title, lightly
 * sanitized (not slugified) — see sanitizeTitleSegment. Every doc is
 * materialized as a directory containing exactly one `_doc.md` file plus zero
 * or more child directories (spec §1.2) — but that "_doc.md" framing is a
 * Projection-1 (sandbox) concern; this module only deals in paths (the
 * directory's own path, without a trailing "/_doc.md") and content strings
 * (frontmatter + body, spec §1.3).
 */
import { createHash } from "node:crypto"
import matter from "gray-matter"
import getPrisma from "@/lib/db"
import { Prisma } from "@prisma/client"
import { createDocument, updateDocument, deleteDocument, hydrateDocument, DocumentError } from "@/lib/document-service"

/** Cast a plain metadata object to Prisma's InputJsonValue type required for Json fields. */
function toJsonInput(data: Record<string, unknown>): Prisma.InputJsonValue {
  return data as unknown as Prisma.InputJsonValue
}

export class DocFsError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message)
    this.name = "DocFsError"
  }
}

export type DocFsNode = {
  path: string
  docId: string
  title: string
  parentId: string | null
  roadmapItemId: string | null
  docType: "STANDARD" | "GTM_POSITIONING_BRIEF"
  hasChildren: boolean
  updatedAt: Date
}

export type DocFsMutationOptions = {
  operationId?: string
  expectedRevision?: string
  authorId?: string | null
  authorName: string
  /**
   * Discriminates "same operationId, different actor" from a genuine retry in
   * document-service's idempotency digest (see lib/document-mcp-actor.ts).
   * Forwarded verbatim when present -- doc-fs never derives its own.
   */
  actorKey?: string
}

/** Builds the shared authorId/authorName/actorKey slice of DocumentMutationOptions from a DocFsMutationOptions. */
function actorOpts(opts: DocFsMutationOptions) {
  return { authorId: opts.authorId ?? null, authorName: opts.authorName, ...(opts.actorKey ? { actorKey: opts.actorKey } : {}) }
}

const MAX_SEGMENT_BYTES = 200
// eslint-disable-next-line no-control-regex
const ILLEGAL_CHARS = /[/\\:*?"<>|\x00-\x1f]/g

/**
 * A path segment is the doc's title, lightly sanitized — not a slugified
 * lowercase string (spec §1.1). Filesystem-illegal characters become `_`;
 * leading/trailing whitespace and trailing dots are trimmed; length is capped
 * at 200 UTF-8 bytes (truncate, not reject).
 */
export function sanitizeTitleSegment(title: string): string {
  let s = title.replace(ILLEGAL_CHARS, "_").trim()
  while (s.endsWith(".")) s = s.slice(0, -1)
  s = s.trim()
  if (!s) s = "Untitled"
  const buf = Buffer.from(s, "utf8")
  if (buf.byteLength > MAX_SEGMENT_BYTES) {
    // toString("utf8") replaces a truncated trailing multi-byte sequence with
    // U+FFFD rather than throwing — strip it so a byte-boundary cut never
    // leaves a mangled replacement character at the end of the segment.
    s = buf.subarray(0, MAX_SEGMENT_BYTES).toString("utf8").replace(/�+$/, "").trim()
    while (s.endsWith(".")) s = s.slice(0, -1)
    if (!s) s = "Untitled"
  }
  return s
}

/** First 8 hex chars of a docId, used to disambiguate a title collision among siblings. */
function collisionSuffix(docId: string): string {
  return docId.replace(/-/g, "").slice(0, 8)
}

/**
 * A deterministic, syntactically-valid UUID derived from two strings. Not a
 * real RFC 4122 v5 UUID (no namespace canonicalization) — just a stable digest
 * reshaped to satisfy document-service's operationId format check, so a caller
 * that needs one distinct operationId per sub-operation (e.g. doc-fs's own
 * recursive delete, or the sandbox reconciler's per-doc write) can derive it
 * deterministically and safely retry the whole pass.
 */
export function deriveOperationId(base: string, salt: string): string {
  const hex = createHash("sha256").update(`${base}:${salt}`).digest("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

type DocRow = {
  id: string
  title: string
  parentId: string | null
  roadmapItemId: string | null
  docType: string
  updatedAt: Date
}

/** Builds every doc's path in one pass, deduping sibling title collisions deterministically. */
function buildTree(docs: DocRow[]): DocFsNode[] {
  const presentIds = new Set(docs.map((d) => d.id))
  const childrenByParent = new Map<string | null, DocRow[]>()
  for (const d of docs) {
    const key = d.parentId && presentIds.has(d.parentId) ? d.parentId : null
    if (!childrenByParent.has(key)) childrenByParent.set(key, [])
    childrenByParent.get(key)!.push(d)
  }

  function segmentsFor(siblings: DocRow[]): Map<string, string> {
    const seenCount = new Map<string, number>()
    const segByDocId = new Map<string, string>()
    for (const d of siblings) {
      const base = sanitizeTitleSegment(d.title)
      const seen = seenCount.get(base) ?? 0
      seenCount.set(base, seen + 1)
      segByDocId.set(d.id, seen === 0 ? base : `${base} (${collisionSuffix(d.id)})`)
    }
    return segByDocId
  }

  const results: DocFsNode[] = []
  function walk(parentId: string | null, parentPath: string) {
    const siblings = childrenByParent.get(parentId) ?? []
    const segments = segmentsFor(siblings)
    for (const d of siblings) {
      const path = parentPath ? `${parentPath}/${segments.get(d.id)}` : segments.get(d.id)!
      results.push({
        path,
        docId: d.id,
        title: d.title,
        parentId: d.parentId,
        roadmapItemId: d.roadmapItemId,
        docType: d.docType === "GTM_POSITIONING_BRIEF" ? "GTM_POSITIONING_BRIEF" : "STANDARD",
        hasChildren: (childrenByParent.get(d.id) ?? []).length > 0,
        updatedAt: d.updatedAt,
      })
      walk(d.id, path)
    }
  }
  walk(null, "")
  return results
}

/**
 * Every doc in a workspace, as a flat list of virtual-filesystem nodes.
 * Recomputed on every call — collision suffixes are never stored, so a doc
 * that stops colliding goes back to a bare path next call, no migration
 * needed (spec §1.1).
 */
export async function listPaths(workspaceId: string): Promise<DocFsNode[]> {
  const prisma = getPrisma()
  const docs = await prisma.doc.findMany({
    where: { workspaceId },
    orderBy: [{ parentId: "asc" }, { sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    select: { id: true, title: true, parentId: true, roadmapItemId: true, docType: true, updatedAt: true },
  })
  return buildTree(docs)
}

/** Resolves one path to its node (docId, title, etc.), or null if it doesn't exist. */
export async function resolvePath(workspaceId: string, path: string): Promise<DocFsNode | null> {
  const nodes = await listPaths(workspaceId)
  return nodes.find((n) => n.path === path) ?? null
}

export type DocFsContent = { docId: string; content: string; revision: string | null }

/**
 * Reads one doc's content as frontmatter + body (spec §1.3). Reserved
 * `compass_`-prefixed keys are always re-injected from the doc's own
 * identity/type/link fields, taking precedence over any same-named key that
 * somehow ended up in user metadata (it shouldn't — writePath strips them on
 * ingestion — but a reserved namespace should never be shadowable on read).
 */
export async function readPath(workspaceId: string, path: string): Promise<DocFsContent | null> {
  const node = await resolvePath(workspaceId, path)
  if (!node) return null
  const prisma = getPrisma()
  const doc = await prisma.doc.findUnique({ where: { id: node.docId } })
  if (!doc || doc.workspaceId !== workspaceId) return null
  const hydrated = await hydrateDocument(workspaceId, doc)
  const userMetadata =
    doc.metadata && typeof doc.metadata === "object" && !Array.isArray(doc.metadata)
      ? (doc.metadata as Record<string, unknown>)
      : {}
  const frontmatter: Record<string, unknown> = {
    ...userMetadata,
    compass_doc_id: doc.id,
    compass_doc_type: doc.docType,
    ...(doc.roadmapItemId ? { compass_roadmap_item_id: doc.roadmapItemId } : {}),
  }
  const content = matter.stringify(hydrated.content ?? "", frontmatter)
  return { docId: doc.id, content, revision: doc.revision }
}

/** Strips reserved `compass_`-prefixed keys from a parsed frontmatter object. */
function stripReservedKeys(data: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!data) return null
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(data)) {
    if (!key.startsWith("compass_")) out[key] = value
  }
  return Object.keys(out).length > 0 ? out : null
}

function splitPath(path: string): string[] {
  return path.split("/").filter((segment) => segment.length > 0)
}

async function nextSortOrder(workspaceId: string, parentId: string | null): Promise<number> {
  const prisma = getPrisma()
  const last = await prisma.doc.findFirst({
    where: { workspaceId, parentId },
    orderBy: { sortOrder: "desc" },
    select: { sortOrder: true },
  })
  return last ? last.sortOrder + 1 : 0
}

/**
 * Resolves every directory segment except the last, creating an empty
 * intermediate doc for any prefix that doesn't already exist ("mkdir -p"
 * semantics for a nested write_doc/create_doc path — spec §3.2's "parent
 * directories in path are created implicitly").
 */
async function ensureParentChain(
  workspaceId: string,
  parentSegments: string[],
  opts: DocFsMutationOptions
): Promise<string | null> {
  let parentId: string | null = null
  let builtPath = ""
  for (const segment of parentSegments) {
    builtPath = builtPath ? `${builtPath}/${segment}` : segment
    const existing = await resolvePath(workspaceId, builtPath)
    if (existing) {
      parentId = existing.docId
      continue
    }
    const sortOrder = await nextSortOrder(workspaceId, parentId)
    const created = await createDocument(
      { workspaceId, parentId, title: segment, content: null, sortOrder },
      { ...actorOpts(opts), operationId: deriveOperationId(opts.operationId ?? "doc-fs", builtPath) }
    )
    parentId = created.id
  }
  return parentId
}

export type WritePathResult = { docId: string; created: boolean; revision: string | null; path: string }

/**
 * Create-or-update by path. `path` already tells you which one it is — a
 * write to a path that resolves is an update; a write to a path that doesn't
 * is a create (spec §3.2). Never accepts a client-supplied compass_doc_id if
 * it disagrees with the doc actually being written (spec §1.3) — reserved
 * keys are simply stripped and re-derived, never trusted as input.
 */
export async function writePath(
  workspaceId: string,
  path: string,
  content: string,
  opts: DocFsMutationOptions
): Promise<WritePathResult> {
  const segments = splitPath(path)
  if (segments.length === 0) throw new DocFsError("invalid-path", `Invalid doc path: "${path}".`)
  const parsed = matter(content)
  // Trim only the blank line gray-matter leaves behind after stripping an
  // actual frontmatter block. Content with no frontmatter is stored exactly
  // as given -- unlike the old create_doc/update_doc handlers, which trimmed
  // unconditionally even without frontmatter. This matters for byte-exact
  // round-tripping through the sandbox materialization path (Projection 1):
  // an agent's untouched file must read back identical to what was written,
  // not silently have its leading whitespace stripped.
  const body = parsed.matter ? parsed.content.trimStart() : content
  const metadata = stripReservedKeys(parsed.data && Object.keys(parsed.data).length > 0 ? (parsed.data as Record<string, unknown>) : null)

  const existing = await resolvePath(workspaceId, path)
  if (existing) {
    const updated = await updateDocument(
      existing.docId,
      { content: body, metadata: metadata ? toJsonInput(metadata) : undefined },
      { operationId: opts.operationId, expectedRevision: opts.expectedRevision, ...actorOpts(opts) }
    )
    return { docId: updated.id, created: false, revision: updated.revision, path }
  }

  const title = segments[segments.length - 1]
  const parentId = await ensureParentChain(workspaceId, segments.slice(0, -1), opts)
  const sortOrder = await nextSortOrder(workspaceId, parentId)
  const created = await createDocument(
    { workspaceId, parentId, title, content: body, metadata: metadata ? toJsonInput(metadata) : undefined, sortOrder },
    { operationId: opts.operationId, ...actorOpts(opts) }
  )
  return { docId: created.id, created: true, revision: created.revision, path }
}

export type DeletePathOptions = DocFsMutationOptions & { recursive?: boolean }

/**
 * Deletes the doc at `path`. Refuses (matching Unix `rmdir` vs `rm -r`) if it
 * has children unless `recursive` is set, in which case every descendant is
 * deleted bottom-up so a child's deletion is always recorded before its
 * parent's (spec §3.2).
 */
export async function deletePath(workspaceId: string, path: string, opts: DeletePathOptions): Promise<void> {
  const node = await resolvePath(workspaceId, path)
  if (!node) throw new DocFsError("not-found", `No doc at path "${path}".`)

  if (!node.hasChildren) {
    await deleteDocument(node.docId, {
      operationId: opts.operationId,
      expectedRevision: opts.expectedRevision,
      ...actorOpts(opts),
      workspaceId,
    })
    return
  }
  if (!opts.recursive) {
    throw new DocFsError("has-children", `Doc at "${path}" has children; pass recursive: true to delete anyway.`)
  }

  const all = await listPaths(workspaceId)
  const descendants = all.filter((n) => n.path === path || n.path.startsWith(`${path}/`))
  // Deepest paths first so a child is always deleted before its parent.
  descendants.sort((a, b) => b.path.split("/").length - a.path.split("/").length)
  for (const d of descendants) {
    await deleteDocument(d.docId, {
      operationId: opts.operationId ? deriveOperationId(opts.operationId, d.docId) : undefined,
      expectedRevision: d.docId === node.docId ? opts.expectedRevision : undefined,
      ...actorOpts(opts),
      workspaceId,
    })
  }
}

/**
 * Renames and/or reparents the doc at `fromPath` to `toPath`, uniformly — both
 * are just "the path changed" (spec §3.2). Missing intermediate directories on
 * the destination are created implicitly, same as writePath.
 */
export async function movePath(
  workspaceId: string,
  fromPath: string,
  toPath: string,
  opts: DocFsMutationOptions
): Promise<{ docId: string; revision: string | null }> {
  const node = await resolvePath(workspaceId, fromPath)
  if (!node) throw new DocFsError("not-found", `No doc at path "${fromPath}".`)
  const toSegments = splitPath(toPath)
  if (toSegments.length === 0) throw new DocFsError("invalid-path", `Invalid destination path: "${toPath}".`)
  if (toPath === fromPath) return { docId: node.docId, revision: null }
  // A doc cannot be moved inside its own subtree.
  if (toPath === fromPath || toPath.startsWith(`${fromPath}/`)) {
    throw new DocFsError("invalid-move", `Cannot move "${fromPath}" into its own subtree.`)
  }

  const title = toSegments[toSegments.length - 1]
  const parentId = await ensureParentChain(workspaceId, toSegments.slice(0, -1), opts)
  const sortOrder = await nextSortOrder(workspaceId, parentId)
  const updated = await updateDocument(
    node.docId,
    { title, parentId, sortOrder },
    { operationId: opts.operationId, expectedRevision: opts.expectedRevision, ...actorOpts(opts) }
  )
  return { docId: updated.id, revision: updated.revision }
}

/**
 * Records the agent's rejected content as a labeled, NON-CURRENT DocVersion —
 * never touches the doc's live content/title (spec §2.4's "never silently
 * overwrite/never silently drop" requirement for a revision conflict). Used
 * only by the sandbox reconciler (lib/agent-doc-reconciliation.ts) when a
 * writePath/movePath call loses a race against a concurrent human edit.
 * A no-op if the doc no longer exists at all (an even rarer race).
 */
export async function recordConflictingSnapshot(docId: string, content: string, authorName: string): Promise<void> {
  const prisma = getPrisma()
  const doc = await prisma.doc.findUnique({ where: { id: docId }, select: { id: true, title: true, icon: true } })
  if (!doc) return
  const parsed = matter(content)
  const body = parsed.matter ? parsed.content.trimStart() : content
  const metadata = stripReservedKeys(parsed.data && Object.keys(parsed.data).length > 0 ? (parsed.data as Record<string, unknown>) : null)
  await prisma.docVersion.create({
    data: {
      docId: doc.id,
      title: doc.title,
      content: body,
      metadata: metadata ?? undefined,
      icon: doc.icon,
      label: `Agent's conflicting edit — not applied (${new Date().toISOString()})`,
      createdByName: authorName,
    },
  })
}

export { DocumentError }
