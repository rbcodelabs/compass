/**
 * Read side of Geode doc sync (spike): the scan a sync client calls to learn what changed.
 *
 *   - No cursor, an unparseable cursor, a cursor ahead of the log, or a cursor older than the
 *     oldest retained change => mode "snapshot": every STANDARD doc, plus a fresh cursor.
 *   - A valid cursor => mode "delta": entries for docs changed after it (latest change per doc),
 *     tombstones for deleted docs, plus the cursor to resume from.
 *
 * The cursor is the per-workspace change `seq`, wrapped so clients treat it as opaque. Entries carry
 * the doc's CURRENT path (a MOVE shows up as the same id at a new path); tombstones carry the last
 * path it had. size/hash describe the file text a client would read (frontmatter + body).
 * Only STANDARD docs are exposed.
 */
import { createHash } from "node:crypto"
import getPrisma from "@/lib/db"
import { hydrateDocument } from "@/lib/document-service"
import { buildTree } from "@/lib/doc-virtual-paths"
import { renderDocFile } from "@/lib/doc-fs"
import { docRevisionOf, isDocsSyncEnabled } from "@/lib/doc-sync"

export type DocSyncEntry = {
  id: string
  path: string
  kind: "file" | "folder" | "tombstone"
  revision: string | null
  size: number
  hash: string | null
}
export type DocSyncScan = {
  mode: "snapshot" | "delta"
  cursor: string
  /** Delta only: more changes remain after `cursor`; call again with it. Always false for a snapshot. */
  hasMore: boolean
  entries: DocSyncEntry[]
}

export class DocSyncDisabledError extends Error {
  constructor() { super("Doc sync is not enabled."); this.name = "DocSyncDisabledError" }
}

export const DOC_SYNC_DEFAULT_LIMIT = 500
const CURSOR_PREFIX = "dsc1:"
const HYDRATE_BATCH = 16

export function encodeSyncCursor(seq: number): string {
  return Buffer.from(`${CURSOR_PREFIX}${seq}`).toString("base64url")
}

/** Returns the seq, or null for anything that is not a cursor this module issued. */
export function decodeSyncCursor(cursor: string): number | null {
  let text: string
  try { text = Buffer.from(cursor, "base64url").toString("utf8") } catch { return null }
  if (!text.startsWith(CURSOR_PREFIX)) return null
  const digits = text.slice(CURSOR_PREFIX.length)
  if (!/^\d{1,9}$/.test(digits)) return null
  return Number(digits)
}

type DocRecord = NonNullable<Awaited<ReturnType<typeof loadDocs>>>[number]

function loadDocs(workspaceId: string) {
  return getPrisma().doc.findMany({
    where: { workspaceId },
    orderBy: [{ parentId: "asc" }, { sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }],
  })
}

async function toEntries(workspaceId: string, docs: DocRecord[], only: Set<string> | null): Promise<DocSyncEntry[]> {
  const nodes = buildTree(docs).filter((n) => n.docType === "STANDARD" && (!only || only.has(n.docId)))
  const byId = new Map(docs.map((d) => [d.id, d]))
  const entries: DocSyncEntry[] = []
  for (let i = 0; i < nodes.length; i += HYDRATE_BATCH) {
    const batch = nodes.slice(i, i + HYDRATE_BATCH)
    entries.push(...await Promise.all(batch.map(async (node) => {
      const doc = byId.get(node.docId)!
      const hydrated = await hydrateDocument(workspaceId, doc)
      const text = renderDocFile(doc, hydrated.content)
      // An implicit parent (created by mkdir -p semantics) has no body of its own: a folder.
      const isFolder = node.hasChildren && !(hydrated.content ?? "").trim()
      const bytes = Buffer.from(text, "utf8")
      return {
        id: doc.id,
        path: node.path,
        kind: isFolder ? "folder" : "file",
        revision: docRevisionOf(doc),
        size: bytes.byteLength,
        hash: createHash("sha256").update(bytes).digest("hex"),
      } satisfies DocSyncEntry
    })))
  }
  return entries
}

export async function scanDocs(workspaceId: string, opts: { cursor?: string; limit?: number }): Promise<DocSyncScan> {
  if (!isDocsSyncEnabled()) throw new DocSyncDisabledError()
  const prisma = getPrisma()
  const limit = Math.max(1, Math.min(opts.limit ?? DOC_SYNC_DEFAULT_LIMIT, 1000))

  // Head is read BEFORE the docs, so a change landing mid-scan is re-delivered by the next delta
  // (entries are idempotent upserts) rather than skipped.
  const head = (await prisma.docChange.findFirst({ where: { workspaceId }, orderBy: { seq: "desc" }, select: { seq: true } }))?.seq ?? 0
  const requested = opts.cursor ? decodeSyncCursor(opts.cursor) : null

  let stale = requested === null || requested > head
  if (!stale && requested! < head) {
    const oldest = await prisma.docChange.findFirst({ where: { workspaceId }, orderBy: { seq: "asc" }, select: { seq: true } })
    // The log was pruned past the client's position: it cannot be replayed without gaps.
    stale = !oldest || oldest.seq > requested! + 1
  }

  if (stale) {
    return { mode: "snapshot", cursor: encodeSyncCursor(head), hasMore: false, entries: await toEntries(workspaceId, await loadDocs(workspaceId), null) }
  }

  const rows = await prisma.docChange.findMany({
    where: { workspaceId, seq: { gt: requested! } },
    orderBy: { seq: "asc" },
    take: limit + 1,
  })
  const hasMore = rows.length > limit
  const page = rows.slice(0, limit)
  const resumeSeq = page.length ? page[page.length - 1].seq : requested!

  const latest = new Map<string, (typeof page)[number]>()
  for (const row of page) latest.set(row.docId, row)

  const tombstones: DocSyncEntry[] = []
  const live = new Set<string>()
  for (const row of latest.values()) {
    if (row.kind === "DELETE") tombstones.push({ id: row.docId, path: row.path, kind: "tombstone", revision: row.revision, size: 0, hash: null })
    else live.add(row.docId)
  }
  // A doc with a pending UPSERT/MOVE that no longer exists (deleted on a later page) yields nothing
  // here; its tombstone arrives with the page that contains the DELETE.
  const upserts = live.size ? await toEntries(workspaceId, await loadDocs(workspaceId), live) : []
  return { mode: "delta", cursor: encodeSyncCursor(resumeSeq), hasMore, entries: [...upserts, ...tombstones] }
}
