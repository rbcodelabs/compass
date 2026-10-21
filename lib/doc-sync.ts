/**
 * Geode doc sync: per-workspace change log (ADR "Compass as a Geode Sync Provider", spike).
 *
 * `recordDocChange` is called INSIDE the same transaction as every doc mutation, so a change row
 * exists if and only if the mutation committed. Everything here is a no-op unless DOCS_SYNC_ENABLED
 * is on, so flag-off behaviour is unchanged. The scan (read) side lives in lib/doc-sync-scan.ts,
 * which needs doc-fs and so cannot be imported here.
 *
 * Scope (v1): STANDARD docs with no CANVAS / GTM ancestor (see syncScopeRows). Changes are computed
 * by diffing the in-scope path tree before and after the mutation, so a doc entering or leaving
 * scope (moved under / out of a canvas), a descendant whose prefix changed, a sibling whose
 * "(suffix)" collision name changed, and a parent that flipped between file and folder are all
 * logged without per-case code.
 *
 * Sequence allocation: one counter row per workspace (doc_change_counters). The FIRST step of
 * recordDocChange locks it (upsert with increment 0); only then is the doc tree read, and the seq
 * range is reserved at the end. Locking before reading matters on Postgres READ COMMITTED: a writer
 * that waited for the lock reads the tree the previous writer committed, so two concurrent
 * mutations cannot each diff against a stale tree. Aurora DSQL has no row locks; a concurrent writer
 * fails with a serialization error instead, and `withDocChangeRetry` re-runs the whole
 * transaction (bounded). A rolled-back mutation rolls its increment back, so seqs have no gaps.
 *
 * Log epoch: the counter row carries a random `epoch` generated when the row is created. Scan cursors
 * embed a tag of (epoch, DOCS_SYNC_EPOCH); a mismatch makes the scan answer with a full snapshot.
 * While the flag is OFF, `noteDocWriteWhileSyncOff` marks the counter `dirty` and rotates its epoch on
 * the first doc write (one statement that matches no row afterwards, and nothing when no counter
 * exists), so re-enabling always forces clients to re-snapshot. The first logged write clears `dirty`.
 * It runs BEFORE the mutation, outside its transaction, and never throws: flag-off writes must not fail
 * because the migration is not applied yet. DOCS_SYNC_EPOCH stays as an extra manual knob.
 *
 * A counter row that is deleted while change rows remain is re-seeded from the highest existing seq, so
 * the unique (workspace_id, seq) index can never collide with the log it left behind.
 */
import { randomUUID } from "node:crypto"
import type { AppPrismaClient, AppTransactionClient } from "@/lib/db"
import { buildTree, syncScopeRows } from "@/lib/doc-virtual-paths"

export type DocChangeKind = "UPSERT" | "MOVE" | "DELETE"

export function isDocsSyncEnabled(): boolean {
  const value = (process.env.DOCS_SYNC_ENABLED ?? "").trim().toLowerCase()
  return value === "1" || value === "true"
}

/** Operator-controlled generation of the log; change it whenever sync is re-enabled after being off. */
export function configuredSyncEpoch(): string {
  return (process.env.DOCS_SYNC_EPOCH ?? "0").trim() || "0"
}

export function docRevisionOf(doc: { revision: string | null; updatedAt: Date }): string {
  return doc.revision ?? `legacy:${doc.updatedAt.toISOString()}`
}

type ChangeClient = Pick<AppTransactionClient, "doc" | "docChange" | "docChangeCounter">

const MAX_ATTEMPTS = 6
const CHANGE_CHUNK = 500

/** Serialization / write-conflict failures from Postgres (40001, 40P01), Aurora DSQL (OC000, OC001), and a lost counter-row insert race. */
export function isDocChangeConflict(error: unknown, depth = 0): boolean {
  if (!error || typeof error !== "object" || depth > 4) return false
  type Shaped = { code?: unknown; originalCode?: unknown; message?: unknown; cause?: unknown; meta?: { code?: unknown; modelName?: unknown; target?: unknown; driverAdapterError?: { cause?: { originalCode?: unknown; constraint?: unknown } } } }
  const e = error as Shaped
  const codes = [e.code, e.originalCode, e.meta?.code, e.meta?.driverAdapterError?.cause?.originalCode].filter((c): c is string => typeof c === "string")
  if (codes.some((c) => ["P2034", "40001", "40P01", "OC000", "OC001"].includes(c))) return true
  // Two first-ever writers racing to create the counter row: the loser sees a unique violation on it
  // (Prisma P2002 or Postgres 23505) naming the counter model, table or primary key, wherever the adapter put it.
  if (codes.some((c) => c === "P2002" || c === "23505")) {
    let meta = ""
    try { meta = JSON.stringify(e.meta ?? {}) } catch { /* circular metadata: fall back to the message */ }
    if (/DocChangeCounter|doc_change_counters/.test(`${meta} ${typeof e.message === "string" ? e.message : ""}`)) return true
  }
  if (typeof e.message === "string" && /\bOC00[01]\b|could not serialize access|deadlock detected|serialization failure|write conflict/i.test(e.message)) return true
  return e.cause !== undefined && e.cause !== error ? isDocChangeConflict(e.cause, depth + 1) : false
}

/**
 * Re-runs `run` (which must be a WHOLE transaction, re-reading anything it depends on) when it loses a
 * write conflict. With the flag off it is a plain call, so existing behaviour is unchanged.
 */
export async function withDocChangeRetry<T>(run: () => Promise<T>): Promise<T> {
  if (!isDocsSyncEnabled()) return run()
  for (let attempt = 1; ; attempt++) {
    try { return await run() } catch (error) {
      if (attempt >= MAX_ATTEMPTS || !isDocChangeConflict(error)) throw error
      await new Promise((resolve) => setTimeout(resolve, Math.random() * 15 * attempt))
    }
  }
}

/**
 * For writers that bypass document-service (legacy direct-Prisma paths): runs `write` and the change
 * rows in one transaction when sync is on; a plain call against `db` when it is off (after noting the
 * write so a later re-enable forces a re-snapshot). With `docId` the doc's pre-write title / parent /
 * sort order are read INSIDE the transaction after the counter lock, so a retried attempt never diffs
 * against a stale read.
 */
export async function writeDocWithChange<T extends { id: string; workspaceId?: string }>(
  db: AppPrismaClient,
  opts: { workspaceId: string; docId?: string; kind: DocChangeKind | ((result: { id: string }, before: DocBefore | null) => DocChangeKind); before?: DocBefore | null },
  write: (client: Pick<AppTransactionClient, "doc">) => Promise<T>,
): Promise<T> {
  if (!isDocsSyncEnabled()) {
    await noteDocWriteWhileSyncOff(db, opts.workspaceId)
    return write(db)
  }
  return withDocChangeRetry(() => db.$transaction(async (tx) => {
    let before: DocBefore | null | undefined = opts.before
    if (opts.docId) {
      await lockCounter(tx, opts.workspaceId)
      const current = await tx.doc.findUnique({ where: { id: opts.docId }, select: { title: true, parentId: true, sortOrder: true } })
      before = current ?? undefined
    }
    const result = await write(tx)
    await recordDocChange(tx, opts.workspaceId, result.id, typeof opts.kind === "function" ? opts.kind(result, before ?? null) : opts.kind, before)
    return result
  }))
}

/**
 * Flag-off bookkeeping: the first doc write after sync was on marks the counter dirty and rotates its
 * epoch so clients re-snapshot after a re-enable. Best effort by design (see header); never throws.
 */
export async function noteDocWriteWhileSyncOff(db: Pick<AppPrismaClient, "docChangeCounter">, workspaceId: string): Promise<void> {
  if (isDocsSyncEnabled()) return
  try {
    await db.docChangeCounter.updateMany({ where: { workspaceId, dirty: false }, data: { dirty: true, epoch: randomUUID() } })
  } catch {
    // Table not migrated yet, or a transient error: sync bookkeeping must never fail a doc write.
  }
}

/** The title / parent / sort order a doc had BEFORE the mutation (all three decide sibling order and so the path). */
export type DocBefore = { parentId: string | null; title: string; sortOrder: number }

/** UPSERT, or MOVE when the title or parent changes (either changes the virtual path). */
export function changeKindFor(before: DocBefore, after: { title?: string; parentId?: string | null }): "UPSERT" | "MOVE" {
  const reparented = after.parentId !== undefined && after.parentId !== before.parentId
  const renamed = after.title !== undefined && after.title !== before.title
  return reparented || renamed ? "MOVE" : "UPSERT"
}

type TreeRow = { id: string; title: string; parentId: string | null; roadmapItemId: string | null; docType: string; updatedAt: Date; revision: string | null; sortOrder: number; createdAt: Date }

/** The sibling order the doc queries use (sortOrder, createdAt, id); parentId only groups, which buildTree does itself. */
function bySiblingOrder(a: TreeRow, b: TreeRow): number {
  return a.sortOrder - b.sortOrder || a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

/**
 * Locks (creating if needed) the workspace's counter row. Must be the first statement of the sync step.
 * Clears `dirty` (sync is on again). A counter created while change rows already exist (the old row was
 * deleted) is seeded from the highest existing seq so new seqs cannot collide with the log.
 */
export async function lockCounter(tx: ChangeClient, workspaceId: string) {
  const counter = await tx.docChangeCounter.upsert({
    where: { workspaceId },
    create: { workspaceId, lastSeq: 0, epoch: randomUUID(), dirty: false },
    update: { lastSeq: { increment: 0 }, dirty: false },
  })
  if (counter.lastSeq !== 0) return counter
  const top = await tx.docChange.findFirst({ where: { workspaceId }, orderBy: { seq: "desc" }, select: { seq: true } })
  if (!top || top.seq <= 0) return counter
  return tx.docChangeCounter.update({ where: { workspaceId }, data: { lastSeq: top.seq } })
}

/**
 * Appends change rows for `docId`. Call after the write for UPSERT/MOVE (so path and revision are
 * the new ones) and BEFORE the row is removed for DELETE. `before` is the doc's title/parent before
 * the mutation; pass `null` for a create; omit it when neither changed.
 */
export async function recordDocChange(tx: ChangeClient, workspaceId: string, docId: string, kind: DocChangeKind, before?: DocBefore | null): Promise<void> {
  if (!isDocsSyncEnabled()) return
  await lockCounter(tx, workspaceId) // lock FIRST, then read the tree (see header)
  const rows: TreeRow[] = await tx.doc.findMany({
    where: { workspaceId },
    select: { id: true, title: true, parentId: true, roadmapItemId: true, docType: true, updatedAt: true, revision: true, sortOrder: true, createdAt: true },
    orderBy: [{ parentId: "asc" }, { sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }],
  })
  const mutated = rows.find((r) => r.id === docId)
  if (!mutated) return

  let beforeRows: TreeRow[]
  let afterRows: TreeRow[]
  if (kind === "DELETE") { beforeRows = rows; afterRows = rows.filter((r) => r.id !== docId) }
  else if (before === null) { beforeRows = rows.filter((r) => r.id !== docId); afterRows = rows }
  else {
    afterRows = rows
    // buildTree assigns bare-vs-"(suffix)" names by the order of the rows it is given, so the reverted
    // row must be put back at its OLD sort position, not left where the query found it.
    beforeRows = before ? rows.map((r) => (r.id === docId ? { ...r, parentId: before.parentId, title: before.title, sortOrder: before.sortOrder } : r)).sort(bySiblingOrder) : rows
  }

  const beforeNodes = new Map(buildTree(syncScopeRows(beforeRows)).map((n) => [n.docId, n]))
  const afterTree = buildTree(syncScopeRows(afterRows))
  const afterNodes = new Map(afterTree.map((n) => [n.docId, n]))
  const revisions = new Map(rows.map((r) => [r.id, docRevisionOf(r)]))
  const now = new Date()

  const changes: Array<{ docId: string; kind: DocChangeKind; path: string; revision: string | null; deleted: boolean }> = []
  for (const node of afterTree) {
    const prior = beforeNodes.get(node.docId)
    const revision = revisions.get(node.docId) ?? null
    if (node.docId === docId) changes.push({ docId, kind, path: node.path, revision, deleted: false })
    else if (!prior) changes.push({ docId: node.docId, kind: "UPSERT", path: node.path, revision, deleted: false }) // entered scope
    else if (prior.path !== node.path) changes.push({ docId: node.docId, kind: "MOVE", path: node.path, revision, deleted: false }) // prefix or collision suffix changed
    else if (prior.hasChildren !== node.hasChildren) changes.push({ docId: node.docId, kind: "UPSERT", path: node.path, revision, deleted: false }) // file <-> folder flip
  }
  for (const [id, prior] of beforeNodes) {
    if (!afterNodes.has(id)) changes.push({ docId: id, kind: "DELETE", path: prior.path, revision: revisions.get(id) ?? null, deleted: true }) // deleted or left scope
  }
  if (changes.length === 0) return

  const bumped = await tx.docChangeCounter.update({ where: { workspaceId }, data: { lastSeq: { increment: changes.length } } })
  const base = bumped.lastSeq - changes.length
  const data = changes.map((change, index) => ({
    workspaceId,
    docId: change.docId,
    seq: base + index + 1,
    kind: change.kind,
    revision: change.revision,
    path: change.path,
    deletedAt: change.deleted ? now : null,
    createdAt: now,
  }))
  // Chunked statements; the transaction still holds every row, so a subtree of thousands of docs can
  // exceed Aurora DSQL's per-transaction row limit (known limitation, see the PR).
  for (let i = 0; i < data.length; i += CHANGE_CHUNK) await tx.docChange.createMany({ data: data.slice(i, i + CHANGE_CHUNK) })
}
