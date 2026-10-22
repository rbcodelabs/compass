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
import { sanitizeTitleSegment } from "@/lib/doc-path"
import { createHash, randomUUID } from "node:crypto"
import { safeMatter, stringifyFrontMatter } from "@/lib/safe-matter"
import { normalizeCanvasContent } from "@/lib/json-canvas"
import { followAfterCreate, mcpFollowActor } from "@/lib/following-hooks"
import { normalizeDocType, type DocType } from "@/lib/doc-types"
import { listScopeFrontmatterForDoc } from "@/lib/spec-docs/scopes"
import { validateSpecEmbeds } from "@/lib/spec-docs/validate"
import getPrisma from "@/lib/db"
import { Prisma } from "@prisma/client"
import { createDocument, updateDocument, deleteDocument, hydrateDocument, documentRevision, DocumentError } from "@/lib/document-service"

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
  docType: DocType
  hasChildren: boolean
  updatedAt: Date
}

export type DocFsMutationOptions = {
  /** Create-only: the type of a newly created doc (ignored when the path already exists). Defaults to STANDARD. */
  docType?: DocType
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
  /**
   * Move-only. Doc ids that may already sit at the destination path because they are
   * themselves being moved or deleted in the same reconciliation pass.
   */
  occupantMayLeave?: ReadonlySet<string>
  /**
   * Agent write paths only (MCP write_doc): a write that leaves a SPEC doc with a malformed compass:// link, an unknown embed kind or an
   * embed whose record is not in the doc's workspace is refused. Absent (UI saves, Geode sync, the sandbox reconciler) the write stays
   * lenient: a bad link is kept exactly as written, never rejected and never stripped.
   */
  strictEmbeds?: boolean
}

/** Builds the shared authorId/authorName/actorKey slice of DocumentMutationOptions from a DocFsMutationOptions. */
function actorOpts(opts: DocFsMutationOptions) {
  return { authorId: opts.authorId ?? null, authorName: opts.authorName, ...(opts.actorKey ? { actorKey: opts.actorKey } : {}) }
}

export { sanitizeTitleSegment }

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
        // The column is free-form; only a known type survives, so a SPEC doc is not flattened to STANDARD for the filesystem and agents.
        docType: normalizeDocType(d.docType),
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

/**
 * Resolves one path to its node (docId, title, etc.), or null if it doesn't exist.
 * The path is sanitized segment by segment first, exactly as listPaths builds its
 * paths, so a caller may name a doc by its raw title ("Q3: Plan", ".env/foo") and
 * still find it under the escaped form listing shows. Sanitizing is idempotent, so
 * a path taken from listPaths resolves unchanged.
 */
export async function resolvePath(workspaceId: string, path: string): Promise<DocFsNode | null> {
  const wanted = splitPath(path).join("/")
  const nodes = await listPaths(workspaceId)
  return nodes.find((n) => n.path === wanted) ?? null
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
  return readDocById(workspaceId, node.docId)
}

/**
 * Reads one doc's frontmatter + body by id. Split out of `readPath` so a caller
 * that already holds the whole tree from `listPaths` (the agent turn route
 * materializing every doc) does not re-list the entire workspace once per doc.
 */
export async function readDocById(workspaceId: string, docId: string): Promise<DocFsContent | null> {
  const prisma = getPrisma()
  const doc = await prisma.doc.findUnique({ where: { id: docId } })
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
    // Read-only and derived from the doc's DOC_SPECIFIES_SCOPE links on every read. Like the other compass_ keys it is stripped on
    // ingest (stripReservedKeys) and set last here, so it can be neither spoofed through a write nor shadowed by user metadata.
    ...(doc.docType === "SPEC" ? await specScopesFrontmatter(workspaceId, doc.id) : {}),
  }
  // A stored `compass_scopes` that reached metadata by some other route (a UI properties save) is never reflected on a non-SPEC doc.
  if (doc.docType !== "SPEC") delete frontmatter.compass_scopes
  const content = stringifyFrontMatter(hydrated.content ?? "", frontmatter)
  return { docId: doc.id, content, revision: documentRevision(doc) }
}

async function specScopesFrontmatter(workspaceId: string, docId: string): Promise<{ compass_scopes: string[] }> {
  return { compass_scopes: await listScopeFrontmatterForDoc(getPrisma(), workspaceId, docId) }
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

/**
 * Splits a caller-supplied path and sanitizes every segment, so a path written
 * through here round-trips with `listPaths` (which sanitizes titles): a write to
 * ".env/foo" or "Q3: Plan" resolves to, and is stored under, the same escaped
 * names that listing shows, instead of creating a fresh doc on every write.
 */
function splitPath(path: string): string[] {
  const raw = path.split("/")
  // Refused BEFORE sanitizing: sanitizeTitleSegment turns "" / "." / ".." / "   " into the title
  // "Untitled", so delete_doc("..") would otherwise resolve to a doc someone titled "Untitled".
  // These are exactly the segments validateDocPath rejects.
  if (raw.some((segment) => segment === "" || segment === "." || segment === ".." || segment.trim() === "")) {
    throw new DocFsError("invalid-path", `Invalid doc path: "${path}".`)
  }
  return raw.map(sanitizeTitleSegment)
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
    // A caller-supplied operationId gives its implicit parents a derived id, so a retry of that same
    // call replays them instead of creating twins. With NO caller id the id is fresh each time: a
    // fixed one (the old deriveOperationId("doc-fs", path)) made re-creating a deleted parent path
    // replay the receipt of the DELETED doc and hand back its id (parent-not-found on the child).
    let operationId: string = randomUUID()
    if (opts.operationId) {
      const derived = deriveOperationId(opts.operationId, builtPath)
      const prisma = getPrisma()
      const receipt = await prisma.docOperation.findUnique({ where: { workspaceId_operationId: { workspaceId, operationId: derived } } })
      // Replaying is right only while the doc that receipt created still exists. If it was deleted
      // since (a retry after someone removed it), replaying would return a dead id: create fresh.
      const replayable = !receipt || Boolean(receipt.docId && (await prisma.doc.findUnique({ where: { id: receipt.docId }, select: { id: true } })))
      if (replayable) operationId = derived
    }
    const created = await createDocument(
      { workspaceId, parentId, title: segment, content: null, sortOrder },
      { ...actorOpts(opts), operationId }
    )
    parentId = created.id
  }
  return parentId
}

async function assertSpecEmbeds(workspaceId: string, body: string): Promise<void> {
  const problem = await validateSpecEmbeds({ workspaceId, body })
  if (problem) throw new DocFsError("invalid-embeds", problem)
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
  const parsed = safeMatter(content)
  // Trim only the blank line gray-matter leaves behind after stripping an
  // actual frontmatter block. Content with no frontmatter is stored exactly
  // as given -- unlike the old create_doc/update_doc handlers, which trimmed
  // unconditionally even without frontmatter. This matters for byte-exact
  // round-tripping through the sandbox materialization path (Projection 1):
  // an agent's untouched file must read back identical to what was written,
  // not silently have its leading whitespace stripped.
  let body = parsed.matter ? parsed.content.trimStart() : content
  const metadata = stripReservedKeys(parsed.data && Object.keys(parsed.data).length > 0 ? (parsed.data as Record<string, unknown>) : null)

  const existing = await resolvePath(workspaceId, segments.join("/"))
  const effectiveDocType: DocType = existing ? existing.docType : (opts.docType ?? "STANDARD")
  if (opts.strictEmbeds && effectiveDocType === "SPEC") await assertSpecEmbeds(workspaceId, body)
  // A CANVAS doc's body is a JSON Canvas document, not markdown: validate it
  // (strict Compass card references; blank canvas when empty) before storing.
  if (effectiveDocType === "CANVAS") {
    const canvas = normalizeCanvasContent(body, { strictCards: true })
    if (!canvas.ok) throw new DocFsError("invalid-canvas", canvas.error)
    body = canvas.content
  }
  if (existing) {
    const updated = await updateDocument(
      existing.docId,
      { content: body, metadata: metadata ? toJsonInput(metadata) : undefined },
      { operationId: opts.operationId, expectedRevision: opts.expectedRevision, ...actorOpts(opts) }
    )
    return { docId: updated.id, created: false, revision: documentRevision(updated), path: segments.join("/") }
  }
  return createAtPath(workspaceId, segments, body, metadata, effectiveDocType, opts)
}

/**
 * Create-only counterpart of writePath: refuses with `exists` instead of silently
 * updating whatever already lives at `path`. The sandbox reconciler uses it so an
 * agent-authored file can never overwrite a doc a human (or another turn) created
 * at the same path while the turn ran.
 */
export async function createPath(
  workspaceId: string,
  path: string,
  content: string,
  opts: DocFsMutationOptions
): Promise<WritePathResult> {
  const segments = splitPath(path)
  if (segments.length === 0) throw new DocFsError("invalid-path", `Invalid doc path: "${path}".`)
  if (await resolvePath(workspaceId, segments.join("/"))) {
    // A retried pass (a lost response) finds its own earlier create at the path.
    // The operation receipt tells that apart from someone else's doc, and
    // createDocument replays the original result for the same receipt.
    const receipt = opts.operationId
      ? await getPrisma().docOperation.findUnique({ where: { workspaceId_operationId: { workspaceId, operationId: opts.operationId } } })
      : null
    if (!receipt) throw new DocFsError("exists", `A doc already exists at "${path}".`)
  }
  const parsed = safeMatter(content)
  let body = parsed.matter ? parsed.content.trimStart() : content
  const metadata = stripReservedKeys(parsed.data && Object.keys(parsed.data).length > 0 ? (parsed.data as Record<string, unknown>) : null)
  const docType: DocType = opts.docType ?? "STANDARD"
  if (docType === "CANVAS") {
    const canvas = normalizeCanvasContent(body, { strictCards: true })
    if (!canvas.ok) throw new DocFsError("invalid-canvas", canvas.error)
    body = canvas.content
  }
  return createAtPath(workspaceId, segments, body, metadata, docType, opts)
}

async function createAtPath(
  workspaceId: string,
  segments: string[],
  body: string,
  metadata: Record<string, unknown> | null,
  effectiveDocType: DocType,
  opts: DocFsMutationOptions
): Promise<WritePathResult> {
  const path = segments.join("/")

  const title = segments[segments.length - 1]
  const parentId = await ensureParentChain(workspaceId, segments.slice(0, -1), opts)
  const sortOrder = await nextSortOrder(workspaceId, parentId)
  const created = await createDocument(
    { workspaceId, parentId, title, content: body, metadata: metadata ? toJsonInput(metadata) : undefined, sortOrder, ...(effectiveDocType !== "STANDARD" ? { docType: effectiveDocType } : {}) },
    { operationId: opts.operationId, ...actorOpts(opts) }
  )
  await followAfterCreate({ model: "doc", workspaceId, row: { id: created.id }, actor: async () => mcpFollowActor() ?? { type: "SYSTEM", id: null } })
  return { docId: created.id, created: true, revision: documentRevision(created), path }
}

export type DeletePathOptions = DocFsMutationOptions & { recursive?: boolean }

/**
 * Id-addressed update: the sandbox reconciler holds docIds, and a path computed
 * at baseline time goes stale the moment an earlier action in the same pass
 * renames or reparents an ancestor.
 */
export async function writeDocById(
  workspaceId: string,
  docId: string,
  content: string,
  opts: DocFsMutationOptions
): Promise<{ docId: string; revision: string | null }> {
  const node = await resolveById(workspaceId, docId)
  if (!node) throw new DocFsError("not-found", `No doc with id "${docId}".`)
  const parsed = safeMatter(content)
  let body = parsed.matter ? parsed.content.trimStart() : content
  const metadata = stripReservedKeys(parsed.data && Object.keys(parsed.data).length > 0 ? (parsed.data as Record<string, unknown>) : null)
  if (node.docType === "CANVAS") {
    const canvas = normalizeCanvasContent(body, { strictCards: true })
    if (!canvas.ok) throw new DocFsError("invalid-canvas", canvas.error)
    body = canvas.content
  }
  if (opts.strictEmbeds && node.docType === "SPEC") await assertSpecEmbeds(workspaceId, body)
  const updated = await updateDocument(
    docId,
    { content: body, metadata: metadata ? toJsonInput(metadata) : undefined },
    { operationId: opts.operationId, expectedRevision: opts.expectedRevision, ...actorOpts(opts) }
  )
  return { docId: updated.id, revision: documentRevision(updated) }
}

/** Resolves a doc by id to its current node (and so its current path), or null. */
export async function resolveById(workspaceId: string, docId: string): Promise<DocFsNode | null> {
  const nodes = await listPaths(workspaceId)
  return nodes.find((n) => n.docId === docId) ?? null
}

/**
 * Deletes exactly one doc by id and never its descendants. A doc that still has
 * children throws `has-children`, so a parent's delete can never override a child
 * whose own delete was refused (revision conflict) earlier in the same pass.
 */
export async function deleteDocById(workspaceId: string, docId: string, opts: DocFsMutationOptions): Promise<void> {
  const node = await resolveById(workspaceId, docId)
  if (!node) throw new DocFsError("not-found", `No doc with id "${docId}".`)
  if (node.hasChildren) throw new DocFsError("has-children", `Doc "${node.path}" has children; they were not deleted.`)
  await deleteDocument(docId, {
    operationId: opts.operationId,
    expectedRevision: opts.expectedRevision,
    ...actorOpts(opts),
    workspaceId,
  })
}

/** Id-addressed move: the destination is a path, the source is a docId (see writeDocById). */
export async function moveDocById(
  workspaceId: string,
  docId: string,
  toPath: string,
  opts: DocFsMutationOptions
): Promise<{ docId: string; revision: string | null }> {
  const node = await resolveById(workspaceId, docId)
  if (!node) throw new DocFsError("not-found", `No doc with id "${docId}".`)
  return moveNode(workspaceId, node, toPath, opts)
}

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
  const descendants = all.filter((n) => n.path === node.path || n.path.startsWith(`${node.path}/`))
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
  return moveNode(workspaceId, node, toPath, opts)
}

async function moveNode(
  workspaceId: string,
  node: DocFsNode,
  toPath: string,
  opts: DocFsMutationOptions
): Promise<{ docId: string; revision: string | null }> {
  const fromPath = node.path
  const toSegments = splitPath(toPath)
  if (toSegments.length === 0) throw new DocFsError("invalid-path", `Invalid destination path: "${toPath}".`)
  const normalizedTo = toSegments.join("/")
  if (normalizedTo === fromPath) return { docId: node.docId, revision: null }
  // A doc cannot be moved inside its own subtree.
  if (normalizedTo.startsWith(`${fromPath}/`)) {
    throw new DocFsError("invalid-move", `Cannot move "${fromPath}" into its own subtree.`)
  }
  // Moving onto a path another doc holds would silently give the mover a
  // "(xxxxxxxx)" sibling name. Refuse unless the caller says the occupant is
  // known to be leaving (the reconciler passes the baseline docs it is also moving or deleting).
  const occupant = await resolvePath(workspaceId, normalizedTo)
  if (occupant && occupant.docId !== node.docId && !opts.occupantMayLeave?.has(occupant.docId)) {
    throw new DocFsError("exists", `A doc already exists at "${normalizedTo}".`)
  }

  const title = toSegments[toSegments.length - 1]
  const parentId = await ensureParentChain(workspaceId, toSegments.slice(0, -1), opts)
  const sortOrder = await nextSortOrder(workspaceId, parentId)
  const updated = await updateDocument(
    node.docId,
    { title, parentId, sortOrder },
    { operationId: opts.operationId, expectedRevision: opts.expectedRevision, ...actorOpts(opts) }
  )
  return { docId: updated.id, revision: documentRevision(updated) }
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
  const parsed = safeMatter(content)
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
