/**
 * Geode doc sync: per-workspace change log (ADR "Compass as a Geode Sync Provider", spike).
 *
 * `recordDocChange` is called INSIDE the same transaction as every STANDARD-doc mutation, so a
 * change row exists if and only if the mutation committed. Everything here is a no-op unless
 * DOCS_SYNC_ENABLED is on, so flag-off behaviour is unchanged. The scan (read) side lives in
 * lib/doc-sync-scan.ts, which needs doc-fs and so cannot be imported here.
 *
 * Sequence allocation: one counter row per workspace (doc_change_counters) is incremented with an
 * atomic upsert inside the mutation's transaction. On plain Postgres the row lock serializes
 * writers and releases in commit order, so seq order equals commit order. On Aurora DSQL
 * (optimistic concurrency, no row locks) a concurrent writer fails at commit/with a serialization
 * error instead; `withDocChangeRetry` re-runs the whole transaction a bounded number of times.
 * A rolled-back mutation rolls its increment back too, so seqs have no gaps.
 */
import type { AppPrismaClient, AppTransactionClient } from "@/lib/db"
import { sanitizeTitleSegment } from "@/lib/doc-path"
import { buildTree } from "@/lib/doc-virtual-paths"

export type DocChangeKind = "UPSERT" | "MOVE" | "DELETE"

export function isDocsSyncEnabled(): boolean {
  const value = (process.env.DOCS_SYNC_ENABLED ?? "").trim().toLowerCase()
  return value === "1" || value === "true"
}

export function docRevisionOf(doc: { revision: string | null; updatedAt: Date }): string {
  return doc.revision ?? `legacy:${doc.updatedAt.toISOString()}`
}

type ChangeClient = Pick<AppTransactionClient, "doc" | "docChange" | "docChangeCounter">

const MAX_ATTEMPTS = 6

/** Serialization / write-conflict failures from Postgres (40001, 40P01) and Aurora DSQL (OC000, OC001). */
export function isDocChangeConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  const e = error as { code?: unknown; message?: unknown; cause?: unknown; meta?: { code?: unknown } }
  const code = String(e.code ?? e.meta?.code ?? "")
  if (code === "P2034" || code === "40001" || code === "40P01" || code === "OC000" || code === "OC001") return true
  if (typeof e.message === "string" && /\b(OC000|OC001|40001|40P01)\b|could not serialize|deadlock detected/i.test(e.message)) return true
  return e.cause !== undefined && e.cause !== error ? isDocChangeConflict(e.cause) : false
}

/**
 * Re-runs `run` (which must be a WHOLE transaction) when it loses a write conflict. With the flag
 * off it is a plain call, so existing behaviour (including how conflicts surface) is unchanged.
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
 * row in one transaction when sync is on; a plain call against `db` when it is off.
 */
export async function writeDocWithChange<T extends { id: string; workspaceId?: string }>(
  db: AppPrismaClient,
  opts: { workspaceId: string; kind: DocChangeKind | ((result: T) => DocChangeKind); before?: DocBefore },
  write: (client: Pick<AppTransactionClient, "doc">) => Promise<T>,
): Promise<T> {
  if (!isDocsSyncEnabled()) return write(db)
  return withDocChangeRetry(() => db.$transaction(async (tx) => {
    const result = await write(tx)
    await recordDocChange(tx, opts.workspaceId, result.id, typeof opts.kind === "function" ? opts.kind(result) : opts.kind, opts.before)
    return result
  }))
}

/** The title/parent a doc had BEFORE the mutation, so path changes of colliding siblings can be found. */
export type DocBefore = { parentId: string | null; title: string }

/** UPSERT, or MOVE when the title or parent changes (either changes the virtual path). */
export function changeKindFor(before: DocBefore, after: { title?: string; parentId?: string | null }): "UPSERT" | "MOVE" {
  const reparented = after.parentId !== undefined && after.parentId !== before.parentId
  const renamed = after.title !== undefined && after.title !== before.title
  return reparented || renamed ? "MOVE" : "UPSERT"
}

/**
 * Appends change rows for `docId`. Call after the write for UPSERT/MOVE (so path and revision are
 * the new ones) and BEFORE the row is removed for DELETE.
 *
 * Extra MOVE rows are written for docs whose path changed as a consequence:
 *   - a MOVE: the doc's descendants (their prefix changed);
 *   - a MOVE or DELETE: siblings that share the sanitized title with the doc under its old or new
 *     parent (the "Title (abcd1234)" collision suffix is derived, so one doc leaving or arriving can
 *     rename another), plus their descendants.
 * Non-STANDARD docs (CANVAS, GTM briefs) are never logged: the sync surface is markdown only.
 */
export async function recordDocChange(tx: ChangeClient, workspaceId: string, docId: string, kind: DocChangeKind, before?: DocBefore): Promise<void> {
  if (!isDocsSyncEnabled()) return
  const rows = await tx.doc.findMany({
    where: { workspaceId },
    select: { id: true, title: true, parentId: true, roadmapItemId: true, docType: true, updatedAt: true, revision: true, sortOrder: true, createdAt: true },
    orderBy: [{ parentId: "asc" }, { sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }],
  })
  const row = rows.find((r) => r.id === docId)
  if (!row) return
  const mutated = buildTree(rows).find((n) => n.docId === docId)
  if (!mutated || mutated.docType !== "STANDARD") return

  // Paths other docs have AFTER the mutation (for DELETE: with the doc gone).
  const afterNodes = kind === "DELETE" ? buildTree(rows.filter((r) => r.id !== docId)) : buildTree(rows)
  const revisions = new Map(rows.map((r) => [r.id, docRevisionOf(r)]))

  const affected = new Map<string, { kind: DocChangeKind; path: string }>()
  const mark = (n: { docId: string; path: string }, k: DocChangeKind) => { if (!affected.has(n.docId)) affected.set(n.docId, { kind: k, path: n.path }) }
  mark(mutated, kind)
  const withDescendants = (root: { path: string }) => afterNodes.filter((n) => n.docType === "STANDARD" && n.docId !== docId && n.path.startsWith(`${root.path}/`))

  if (kind === "MOVE") for (const n of withDescendants(afterNodes.find((a) => a.docId === docId)!)) mark(n, "MOVE")

  if (kind === "MOVE" || kind === "DELETE") {
    const old = before ?? { parentId: row.parentId, title: row.title }
    const parents = new Set<string | null>([old.parentId, row.parentId])
    const titles = new Set([sanitizeTitleSegment(old.title), sanitizeTitleSegment(row.title)])
    const siblings = afterNodes.filter((n) => n.docType === "STANDARD" && n.docId !== docId && parents.has(n.parentId) && titles.has(sanitizeTitleSegment(n.title)))
    for (const sibling of siblings) {
      mark(sibling, "MOVE")
      for (const d of withDescendants(sibling)) mark(d, "MOVE")
    }
  }

  const ordered = [...affected.entries()]
  const base = await allocateSeq(tx, workspaceId, ordered.length)
  const now = new Date()
  await tx.docChange.createMany({
    data: ordered.map(([id, change], index) => ({
      workspaceId,
      docId: id,
      seq: base + index + 1,
      kind: change.kind,
      revision: revisions.get(id) ?? null,
      path: id === docId ? mutated.path : change.path,
      deletedAt: kind === "DELETE" && id === docId ? now : null,
      createdAt: now,
    })),
  })
}

/** Reserves `count` consecutive seqs for the workspace and returns the last one used before them. */
async function allocateSeq(tx: ChangeClient, workspaceId: string, count: number): Promise<number> {
  const counter = await tx.docChangeCounter.upsert({
    where: { workspaceId },
    create: { workspaceId, lastSeq: count },
    update: { lastSeq: { increment: count } },
  })
  return counter.lastSeq - count
}
