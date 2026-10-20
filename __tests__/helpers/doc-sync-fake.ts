/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * In-memory Prisma fake for the doc-sync tests: docs, doc_changes, the per-workspace seq counter,
 * and real transaction semantics that matter here:
 *   - a failed transaction is rolled back (per-transaction undo journal, safe under concurrency);
 *   - the counter row behaves like Aurora DSQL's optimistic concurrency: while one open
 *     transaction has written it, another writer's upsert throws a serialization failure (P2034).
 */
export type Row = Record<string, any>

export const store = {
  docs: [] as Row[],
  changes: [] as Row[],
  counters: [] as Row[],
  versions: [] as Row[],
  failChangeWrite: false,
  ids: 0,
  counterOwner: null as symbol | null,
  conflicts: 0,
  trace: [] as string[],
  docFindManyArgs: [] as Row[],
  /** Runs once, inside the first counter lock of the next transaction, then that lock fails with a write conflict. */
  onFirstLock: null as null | (() => void | (() => void)),
  afterRollback: null as null | (() => void),
}

export function resetStore() {
  store.docs.length = 0
  store.changes.length = 0
  store.counters.length = 0
  store.versions.length = 0
  store.failChangeWrite = false
  store.ids = 0
  store.counterOwner = null
  store.conflicts = 0
  store.trace.length = 0
  store.docFindManyArgs.length = 0
  store.onFirstLock = null
  store.afterRollback = null
}

function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, want]) => {
    if (want && typeof want === "object" && "in" in (want as Row)) return (want as { in: unknown[] }).in.includes(row[key])
    if (want && typeof want === "object" && "gt" in (want as Row)) return row[key] > (want as Row).gt
    return row[key] === want
  })
}
function ordered(rows: Row[], orderBy?: Row | Row[]) {
  const keys = (Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []).map((o) => Object.entries(o)[0])
  return [...rows].sort((a, b) => {
    for (const [key, dir] of keys) {
      const av = a[key] ?? null, bv = b[key] ?? null
      if (av === bv) continue
      return (av! < bv! ? -1 : 1) * (dir === "desc" ? -1 : 1)
    }
    return 0
  })
}

type Journal = Array<() => void> | null

function delegate(rows: Row[], journal: Journal, defaults?: () => Row, beforeWrite?: () => void) {
  const track = (undo: () => void) => journal?.push(undo)
  const insert = (data: Row) => { const row = { ...defaults?.(), ...data }; rows.push(row); track(() => { rows.splice(rows.indexOf(row), 1) }); return row }
  const patch = (row: Row, data: Row) => { const before = { ...row }; Object.assign(row, data); track(() => { for (const k of Object.keys(row)) delete row[k]; Object.assign(row, before) }) }
  return {
    findMany: async ({ where, orderBy, take }: Row = {}) => ordered(rows.filter((r) => matches(r, where)), orderBy).slice(0, take ?? undefined).map((r) => ({ ...r })),
    findFirst: async ({ where, orderBy }: Row = {}) => { const r = ordered(rows.filter((x) => matches(x, where)), orderBy)[0]; return r ? { ...r } : null },
    findUnique: async ({ where }: Row) => { const r = rows.find((x) => matches(x, where)); return r ? { ...r } : null },
    create: async ({ data }: Row) => { beforeWrite?.(); return { ...insert(data) } },
    createMany: async ({ data }: Row) => {
      if (store.failChangeWrite) throw new Error("change write failed")
      beforeWrite?.()
      data.forEach((d: Row) => insert(d)); return { count: data.length }
    },
    updateMany: async ({ where, data }: Row) => { const hit = rows.filter((r) => matches(r, where)); hit.forEach((r) => patch(r, data)); return { count: hit.length } },
    update: async ({ where, data }: Row) => { const r = rows.find((x) => matches(x, where))!; patch(r, data); return { ...r } },
    delete: async ({ where }: Row) => { const i = rows.findIndex((x) => matches(x, where)); const [r] = rows.splice(i, 1); track(() => { rows.splice(i, 0, r) }); return r },
    deleteMany: async () => ({ count: 0 }),
    _insert: insert,
    _patch: patch,
  }
}

function client(journal: Journal, txId: symbol | null): Row {
  const docDefaults = () => ({ id: `00000000-0000-4000-8000-${String(++store.ids).padStart(12, "0")}`, parentId: null, content: null, metadata: null, roadmapItemId: null, docType: "STANDARD", sortOrder: 0, storageProvider: null, contentRef: null, icon: null, createdAt: new Date("2026-01-01"), updatedAt: new Date("2026-01-01") })
  const counters = delegate(store.counters, journal)
  return {
    doc: (() => {
      const d = delegate(store.docs, journal, docDefaults)
      const findMany = d.findMany
      return { ...d, findMany: async (args: Row = {}) => { store.docFindManyArgs.push(args); if (journal) store.trace.push("tree"); return findMany(args) } }
    })(),
    docChange: delegate(store.changes, journal),
    docChangeCounter: {
      ...counters,
      update: async ({ where, data }: Row) => {
        const row = store.counters.find((r) => matches(r, where))!
        counters._patch(row, { lastSeq: row.lastSeq + data.lastSeq.increment })
        return { ...row }
      },
      upsert: async ({ where, create, update }: Row) => {
        if (txId) {
          store.trace.push("lock")
          if (store.onFirstLock) { const hook = store.onFirstLock; store.onFirstLock = null; store.afterRollback = hook() ?? null; store.conflicts++; throw Object.assign(new Error("Transaction failed due to a write conflict"), { code: "P2034" }) }
          if (store.counterOwner && store.counterOwner !== txId) { store.conflicts++; throw Object.assign(new Error("Transaction failed due to a write conflict"), { code: "P2034" }) }
          store.counterOwner = txId
        }
        await Promise.resolve()
        const row = store.counters.find((r) => matches(r, where))
        if (!row) return { ...counters._insert(create) }
        counters._patch(row, { lastSeq: row.lastSeq + update.lastSeq.increment })
        return { ...row }
      },
    },
    docVersion: { findFirst: async () => null, create: async () => ({}), deleteMany: async () => ({ count: 0 }), findUnique: async ({ where }: Row) => store.versions.find((v) => matches(v, where)) ?? null },
    docComment: { deleteMany: async () => ({ count: 0 }) },
    docOperation: { findUnique: async () => null, create: async () => ({}) },
    roadmapItem: { findFirst: async () => null, findUnique: async () => null },
    workspace: { findUnique: async () => ({ name: "Compass", slug: "compass", organization: { slug: "org" } }) },
  }
}

export const fake: Row = {
  ...client(null, null),
  $transaction: async (fn: (tx: Row) => Promise<unknown>) => {
    const txId = Symbol("tx")
    const journal: Array<() => void> = []
    try { return await fn(client(journal, txId)) } catch (error) { for (const undo of journal.reverse()) undo(); store.afterRollback?.(); store.afterRollback = null; throw error } finally { if (store.counterOwner === txId) store.counterOwner = null }
  },
}
