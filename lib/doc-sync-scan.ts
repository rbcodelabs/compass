/**
 * Read side of Geode doc sync (spike): the scan a sync client calls to learn what changed.
 *
 *   - No cursor, an unparseable cursor, a cursor from another log epoch, a cursor ahead of the log, or
 *     one older than the oldest retained change => mode "snapshot": every in-scope doc, in path
 *     order, in pages (`hasMore` + `continuation`), plus the delta `cursor` to resume from once the
 *     last page is read. The cursor is the head seq captured when the first page was built, so
 *     anything that changed while the client was paging is re-delivered by the next delta.
 *   - A valid cursor => mode "delta": entries for docs changed after it (latest change per doc),
 *     tombstones for deleted / out-of-scope docs, plus the cursor to resume from.
 *
 * Scope (v1): STANDARD docs with no CANVAS / GTM ancestor. Paths come from the in-scope tree only
 * (see lib/doc-virtual-paths.ts), so they can differ from doc-fs paths when a canvas shares a title with a sibling.
 *
 * `status` mirrors Geode's SyncScanResult: "partial" means at least one doc could not be read and
 * was reported in `skipped` instead of `entries`. A client MUST NOT infer deletions from a partial
 * result. Partial is STICKY across snapshot pages (the skipped count rides in the continuation): once
 * any page skipped a doc, every later page, including the last, is partial and carries `cursor: null`,
 * so a snapshot with a hole can never be adopted as a clean checkpoint. A partial delta does not
 * advance the cursor past the first skipped change; if that means the cursor did not move at all,
 * `hasMore` is false and `reason` is "unreadable-doc-blocks-cursor" so the client stops looping.
 *
 * A continuation that is malformed or belongs to another log epoch is REJECTED with
 * DocSyncContinuationStaleError (HTTP 409 "continuation-stale"); the client restarts the snapshot
 * explicitly by calling again without a continuation. It never silently starts a new snapshot.
 *
 * Cursor format: base64url("dsc1:<epochTag>:<seq>"). epochTag = hash(counter epoch, DOCS_SYNC_EPOCH),
 * so it is bound to one workspace's log. Continuation: base64url(JSON {e, h, a}) = epochTag, head, last path.
 */
import { createHash, randomUUID } from "node:crypto"
import getPrisma from "@/lib/db"
import { DocumentError, hydrateDocument } from "@/lib/document-service"
import { buildTree, syncScopeRows } from "@/lib/doc-virtual-paths"
import { renderDocFile } from "@/lib/doc-fs"
import { configuredSyncEpoch, docRevisionOf, isDocsSyncEnabled } from "@/lib/doc-sync"

export type DocSyncEntry = {
  id: string
  path: string
  kind: "file" | "folder" | "tombstone"
  revision: string | null
  size: number
  hash: string | null
}
export type DocSyncSkipped = { id: string; path: string; error: string }
export type DocSyncScan = {
  mode: "snapshot" | "delta"
  /** "partial": some docs were skipped (see `skipped`); absence from `entries` does NOT mean deletion. */
  status: "complete" | "partial"
  /**
   * Where to resume a delta. For a snapshot, valid only after the last page (`hasMore` false).
   * null when the snapshot skipped any doc: do not adopt it as a checkpoint.
   */
  cursor: string | null
  /** More pages remain: pass `continuation` (snapshot) or call again with `cursor` (delta). */
  hasMore: boolean
  continuation: string | null
  entries: DocSyncEntry[]
  skipped: DocSyncSkipped[]
  /** Why the result is partial or why the client should stop paging; null otherwise. */
  reason: "unreadable-doc" | "unreadable-doc-blocks-cursor" | null
}

export class DocSyncDisabledError extends Error {
  constructor() { super("Doc sync is not enabled."); this.name = "DocSyncDisabledError" }
}

export class DocSyncContinuationStaleError extends Error {
  constructor() { super("continuation-stale: the snapshot continuation is malformed or from another log epoch; restart without a continuation."); this.name = "DocSyncContinuationStaleError" }
}

export const DOC_SYNC_DEFAULT_LIMIT = 500
export const DOC_SYNC_MAX_LIMIT = 1000
const CURSOR_PREFIX = "dsc1:"
const HYDRATE_BATCH = 16

export function epochTag(counterEpoch: string): string {
  return createHash("sha256").update(`${counterEpoch}:${configuredSyncEpoch()}`).digest("hex").slice(0, 12)
}

export function encodeSyncCursor(seq: number, tag: string): string {
  return Buffer.from(`${CURSOR_PREFIX}${tag}:${seq}`).toString("base64url")
}

/** Returns {tag, seq}, or null for anything that is not a cursor this module issued. */
export function decodeSyncCursor(cursor: string): { tag: string; seq: number } | null {
  let text: string
  try { text = Buffer.from(cursor, "base64url").toString("utf8") } catch { return null }
  const match = /^dsc1:([0-9a-f]{12}):(\d{1,9})$/.exec(text)
  return match ? { tag: match[1], seq: Number(match[2]) } : null
}

function encodeContinuation(tag: string, head: number, afterPath: string, skippedSoFar: number): string {
  return Buffer.from(JSON.stringify({ e: tag, h: head, a: afterPath, k: skippedSoFar })).toString("base64url")
}
function decodeContinuation(token: string): { tag: string; head: number; afterPath: string; skippedSoFar: number } | null {
  try {
    const value = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as { e?: unknown; h?: unknown; a?: unknown; k?: unknown }
    if (typeof value.e !== "string" || typeof value.a !== "string" || typeof value.h !== "number" || !Number.isInteger(value.h) || value.h < 0) return null
    const skippedSoFar = typeof value.k === "number" && Number.isInteger(value.k) && value.k >= 0 ? value.k : 0
    return { tag: value.e, head: value.h, afterPath: value.a, skippedSoFar }
  } catch { return null }
}

/** Narrow rows (no body, no metadata) are enough to build the tree. */
function loadTreeRows(workspaceId: string) {
  return getPrisma().doc.findMany({
    where: { workspaceId },
    select: { id: true, title: true, parentId: true, roadmapItemId: true, docType: true, updatedAt: true, revision: true, sortOrder: true, createdAt: true },
    orderBy: [{ parentId: "asc" }, { sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }],
  })
}
type TreeRows = Awaited<ReturnType<typeof loadTreeRows>>
type Node = ReturnType<typeof buildTree>[number]

/** Hydrates only the docs actually emitted; a doc that cannot be read is reported, not fatal. */
async function toEntries(workspaceId: string, treeRows: TreeRows, nodes: Node[]): Promise<{ entries: DocSyncEntry[]; skipped: DocSyncSkipped[] }> {
  const entries: DocSyncEntry[] = []
  const skipped: DocSyncSkipped[] = []
  const revisions = new Map(treeRows.map((r) => [r.id, docRevisionOf(r)]))
  for (let i = 0; i < nodes.length; i += HYDRATE_BATCH) {
    const batch = nodes.slice(i, i + HYDRATE_BATCH)
    const full = await getPrisma().doc.findMany({ where: { workspaceId, id: { in: batch.map((n) => n.docId) } } })
    const byId = new Map(full.map((d) => [d.id, d]))
    const settled = await Promise.allSettled(batch.map(async (node): Promise<DocSyncEntry> => {
      const doc = byId.get(node.docId)
      if (!doc) throw new DocumentError("not-found")
      const hydrated = await hydrateDocument(workspaceId, doc)
      const bytes = Buffer.from(renderDocFile(doc, hydrated.content), "utf8")
      // An implicit parent (created by mkdir -p semantics) has no body of its own: a folder.
      const isFolder = node.hasChildren && !(hydrated.content ?? "").trim()
      return { id: doc.id, path: node.path, kind: isFolder ? "folder" : "file", revision: revisions.get(doc.id) ?? docRevisionOf(doc), size: bytes.byteLength, hash: createHash("sha256").update(bytes).digest("hex") }
    }))
    settled.forEach((result, index) => {
      if (result.status === "fulfilled") entries.push(result.value)
      else skipped.push({ id: batch[index].docId, path: batch[index].path, error: result.reason instanceof DocumentError ? result.reason.code : "hydrate-failed" })
    })
  }
  return { entries, skipped }
}

export async function scanDocs(workspaceId: string, opts: { cursor?: string | null; continuation?: string | null; limit?: number }): Promise<DocSyncScan> {
  if (!isDocsSyncEnabled()) throw new DocSyncDisabledError()
  const prisma = getPrisma()
  const limit = Math.max(1, Math.min(opts.limit ?? DOC_SYNC_DEFAULT_LIMIT, DOC_SYNC_MAX_LIMIT))

  // The counter is read BEFORE the docs, so a change landing mid-scan is re-delivered by the next
  // delta (entries are idempotent upserts) rather than skipped.
  const counter = await ensureCounter(workspaceId)
  const head = counter.lastSeq
  const tag = epochTag(counter.epoch)

  if (opts.continuation) {
    const continuation = decodeContinuation(opts.continuation)
    if (!continuation || continuation.tag !== tag) throw new DocSyncContinuationStaleError()
    await acknowledgeCheckpoint(workspaceId, counter.epoch)
    return snapshotPage(workspaceId, tag, continuation.head, continuation.afterPath, limit, continuation.skippedSoFar)
  }

  const requested = opts.cursor ? decodeSyncCursor(opts.cursor) : null
  let stale = requested === null || requested.tag !== tag || requested.seq > head
  if (!stale && requested!.seq < head) {
    const oldest = await prisma.docChange.findFirst({ where: { workspaceId }, orderBy: { seq: "asc" }, select: { seq: true } })
    // The log was pruned past the client's position: it cannot be replayed without gaps.
    stale = !oldest || oldest.seq > requested!.seq + 1
  }
  await acknowledgeCheckpoint(workspaceId, counter.epoch)
  if (stale) return snapshotPage(workspaceId, tag, head, null, limit)
  return deltaPage(workspaceId, tag, requested!.seq, limit)
}

/**
 * Every scan answer that carries a cursor (or lets one be used) first clears the counter's `dirty`
 * marker for the epoch it is about to issue, so the NEXT doc write made while sync is off rotates the
 * epoch again and invalidates this checkpoint. Conditional on the epoch: a rotation that raced in
 * (a flag-off instance during a rolling deploy) is not undone, and our now-stale cursor simply fails
 * the epoch check on its next use.
 */
async function acknowledgeCheckpoint(workspaceId: string, epoch: string): Promise<void> {
  await getPrisma().docChangeCounter.updateMany({ where: { workspaceId, epoch, dirty: true }, data: { dirty: false } })
}

/**
 * The counter row always exists before a cursor is issued, so every cursor carries a real epoch (an
 * epoch-less checkpoint could not be invalidated by flag-off writes). Insert-if-absent; the loser of a
 * race re-reads the winner's row. A new row is seeded from the highest existing seq like lockCounter does.
 */
async function ensureCounter(workspaceId: string) {
  const prisma = getPrisma()
  const existing = await prisma.docChangeCounter.findUnique({ where: { workspaceId } })
  if (existing) return existing
  const top = await prisma.docChange.findFirst({ where: { workspaceId }, orderBy: { seq: "desc" }, select: { seq: true } })
  try {
    return await prisma.docChangeCounter.create({ data: { workspaceId, lastSeq: top?.seq ?? 0, epoch: randomUUID(), dirty: false } })
  } catch (error) {
    const winner = await prisma.docChangeCounter.findUnique({ where: { workspaceId } })
    if (winner) return winner
    throw error
  }
}

async function snapshotPage(workspaceId: string, tag: string, head: number, afterPath: string | null, limit: number, skippedBefore = 0): Promise<DocSyncScan> {
  const treeRows = await loadTreeRows(workspaceId)
  const all = buildTree(syncScopeRows(treeRows)).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const remaining = afterPath === null ? all : all.filter((n) => n.path > afterPath)
  const page = remaining.slice(0, limit)
  const hasMore = remaining.length > page.length
  const { entries, skipped } = await toEntries(workspaceId, treeRows, page)
  const skippedTotal = skippedBefore + skipped.length
  return {
    mode: "snapshot",
    status: skippedTotal ? "partial" : "complete",
    cursor: skippedTotal ? null : encodeSyncCursor(head, tag),
    hasMore,
    continuation: hasMore ? encodeContinuation(tag, head, page[page.length - 1].path, skippedTotal) : null,
    entries,
    skipped,
    reason: skippedTotal ? "unreadable-doc" : null,
  }
}

async function deltaPage(workspaceId: string, tag: string, fromSeq: number, limit: number): Promise<DocSyncScan> {
  const prisma = getPrisma()
  const rows = await prisma.docChange.findMany({ where: { workspaceId, seq: { gt: fromSeq } }, orderBy: { seq: "asc" }, take: limit + 1 })
  const hasMore = rows.length > limit
  const page = rows.slice(0, limit)

  const latest = new Map<string, (typeof page)[number]>()
  for (const row of page) latest.set(row.docId, row)

  const tombstones: DocSyncEntry[] = []
  const live = new Set<string>()
  for (const row of latest.values()) {
    if (row.kind === "DELETE") tombstones.push({ id: row.docId, path: row.path, kind: "tombstone", revision: row.revision, size: 0, hash: null })
    else live.add(row.docId)
  }
  // A doc with a pending UPSERT/MOVE that is no longer in scope (deleted or moved under a canvas on a
  // later page) yields nothing here; its tombstone arrives with the page holding that change.
  let upserts: DocSyncEntry[] = []
  let skipped: DocSyncSkipped[] = []
  if (live.size) {
    const treeRows = await loadTreeRows(workspaceId)
    const nodes = buildTree(syncScopeRows(treeRows)).filter((n) => live.has(n.docId))
    ;({ entries: upserts, skipped } = await toEntries(workspaceId, treeRows, nodes))
  }

  let resumeSeq = page.length ? page[page.length - 1].seq : fromSeq
  if (skipped.length) {
    // Do not advance past a change we could not deliver.
    const skippedIds = new Set(skipped.map((s) => s.id))
    const firstSkipped = Math.min(...[...latest.values()].filter((r) => skippedIds.has(r.docId)).map((r) => r.seq))
    resumeSeq = Math.max(fromSeq, firstSkipped - 1)
  }
  const stuck = skipped.length > 0 && resumeSeq === fromSeq
  return {
    mode: "delta",
    status: skipped.length ? "partial" : "complete",
    cursor: encodeSyncCursor(resumeSeq, tag),
    hasMore: stuck ? false : hasMore,
    continuation: null,
    entries: [...upserts, ...tombstones],
    skipped,
    reason: stuck ? "unreadable-doc-blocks-cursor" : skipped.length ? "unreadable-doc" : null,
  }
}
