/**
 * Geode doc sync spike: change-log writes (inside the mutation's transaction), the scan's
 * snapshot/delta/tombstone/staleness behaviour, the flag-off no-op, and workspace isolation.
 * Runs the REAL document-service and doc-sync code against a small in-memory Prisma fake.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

type Row = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

const store = vi.hoisted(() => ({ docs: [] as Row[], changes: [] as Row[], failChangeWrite: false, ids: 0 }))

function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, want]) => {
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
const fake = vi.hoisted(() => {
  const delegate = (rows: () => Row[], opts: { defaults?: () => Row } = {}) => ({
    findMany: async ({ where, orderBy, take }: Row = {}) => ordered(rows().filter((r) => matches(r, where)), orderBy).slice(0, take ?? undefined).map((r) => ({ ...r })),
    findFirst: async ({ where, orderBy }: Row = {}) => { const r = ordered(rows().filter((x) => matches(x, where)), orderBy)[0]; return r ? { ...r } : null },
    findUnique: async ({ where }: Row) => { const r = rows().find((x) => matches(x, where)); return r ? { ...r } : null },
    create: async ({ data }: Row) => { const row = { ...opts.defaults?.(), ...data }; rows().push(row); return { ...row } },
    createMany: async ({ data }: Row) => {
      if (store.failChangeWrite) throw new Error("change write failed")
      rows().push(...data.map((d: Row) => ({ ...opts.defaults?.(), ...d }))); return { count: data.length }
    },
    updateMany: async ({ where, data }: Row) => { const hit = rows().filter((r) => matches(r, where)); hit.forEach((r) => Object.assign(r, data)); return { count: hit.length } },
    update: async ({ where, data }: Row) => { const r = rows().find((x) => matches(x, where))!; Object.assign(r, data); return r },
    delete: async ({ where }: Row) => { const i = rows().findIndex((x) => matches(x, where)); const [r] = rows().splice(i, 1); return r },
    deleteMany: async () => ({ count: 0 }),
  })
  const db: Row = {
    doc: delegate(() => store.docs, { defaults: () => ({ id: `00000000-0000-4000-8000-${String(++store.ids).padStart(12, "0")}`, parentId: null, content: null, metadata: null, roadmapItemId: null, docType: "STANDARD", sortOrder: 0, storageProvider: null, contentRef: null, createdAt: new Date("2026-01-01"), updatedAt: new Date("2026-01-01") }) }),
    docChange: delegate(() => store.changes),
    docVersion: { findFirst: async () => null, create: async () => ({}), deleteMany: async () => ({ count: 0 }) },
    docComment: { deleteMany: async () => ({ count: 0 }) },
    docOperation: { findUnique: async () => null, create: async () => ({}) },
    roadmapItem: { findFirst: async () => null },
  }
  db.$transaction = async (fn: (tx: Row) => Promise<unknown>) => {
    // Real transactions roll back; emulate it so "same transaction" is observable.
    const snapshot = { docs: store.docs.map((r) => ({ ...r })), changes: store.changes.map((r) => ({ ...r })) }
    try { return await fn(db) } catch (error) { store.docs.splice(0, store.docs.length, ...snapshot.docs); store.changes.splice(0, store.changes.length, ...snapshot.changes); throw error }
  }
  return db
})
vi.mock("@/lib/db", () => ({ default: () => fake }))
vi.mock("@/lib/following-hooks", () => ({ followAfterCreate: vi.fn(), mcpFollowActor: vi.fn() }))

import { createDocument, deleteDocument, updateDocument } from "@/lib/document-service"
import { moveDocById } from "@/lib/doc-fs"
import { decodeSyncCursor, encodeSyncCursor, scanDocs, DocSyncDisabledError } from "@/lib/doc-sync-scan"

const WS = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const OTHER_WS = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const author = { authorName: "Tester" }
const changesFor = (workspaceId: string) => store.changes.filter((c) => c.workspaceId === workspaceId)
const create = (workspaceId: string, title: string, extra: Row = {}) => createDocument({ workspaceId, title, content: `# ${title}`, ...extra } as never, author)

beforeEach(() => {
  store.docs.length = 0
  store.changes.length = 0
  store.failChangeWrite = false
  store.ids = 0
  vi.stubEnv("DOCS_SYNC_ENABLED", "1")
})
afterEach(() => vi.unstubAllEnvs())

describe("change-log writes", () => {
  it("logs create, update, delete with a per-workspace monotonic seq", async () => {
    const a = await create(WS, "Alpha")
    await updateDocument(a.id, { content: "changed" }, { ...author, expectedRevision: a.revision! })
    await deleteDocument(a.id, { ...author, workspaceId: WS })
    const log = changesFor(WS)
    expect(log.map((c) => [c.seq, c.kind, c.path])).toEqual([[1, "UPSERT", "Alpha"], [2, "UPSERT", "Alpha"], [3, "DELETE", "Alpha"]])
    expect(log[2].deletedAt).toBeInstanceOf(Date)
    expect(log[0].revision).toBe(a.revision)
    expect(log[1].revision).not.toBe(a.revision)
  })

  it("records a rename as MOVE and carries the descendants to their new paths", async () => {
    const parent = await create(WS, "Parent")
    const child = await create(WS, "Child", { parentId: parent.id })
    store.changes.length = 0
    await updateDocument(parent.id, { title: "Renamed" }, { ...author, expectedRevision: parent.revision! })
    expect(store.changes.map((c) => [c.docId, c.kind, c.path])).toEqual([[parent.id, "MOVE", "Renamed"], [child.id, "MOVE", "Renamed/Child"]])
    expect(store.changes.map((c) => c.seq)).toEqual([1, 2])
  })

  it("records a doc-fs move (reparent) as MOVE at the new path", async () => {
    const a = await create(WS, "A")
    const folder = await create(WS, "Folder")
    store.changes.length = 0
    await moveDocById(WS, a.id, "Folder/A", { ...author, expectedRevision: a.revision! })
    expect(store.changes).toHaveLength(1)
    expect(store.changes[0]).toMatchObject({ docId: a.id, kind: "MOVE", path: "Folder/A" })
    expect(folder.id).toBeDefined()
  })

  it("writes the change in the same transaction as the mutation", async () => {
    const a = await create(WS, "Alpha")
    store.failChangeWrite = true
    await expect(updateDocument(a.id, { content: "x" }, { ...author, expectedRevision: a.revision! })).rejects.toThrow("change write failed")
    expect(store.docs[0].content).toBe("# Alpha") // mutation rolled back with the failed change write
    expect(store.changes).toHaveLength(1)
  })

  it("does not log CANVAS or GTM docs", async () => {
    await create(WS, "Board", { docType: "CANVAS", content: JSON.stringify({ nodes: [], edges: [] }) })
    await create(WS, "Brief", { docType: "GTM_POSITIONING_BRIEF" })
    expect(store.changes).toHaveLength(0)
  })

  it("sequences each workspace independently", async () => {
    await create(WS, "One")
    await create(OTHER_WS, "Two")
    await create(WS, "Three")
    expect(changesFor(WS).map((c) => c.seq)).toEqual([1, 2])
    expect(changesFor(OTHER_WS).map((c) => c.seq)).toEqual([1])
  })
})

describe("flag off", () => {
  it.each(["", "0", "false"])("writes no change rows and the scan is disabled (DOCS_SYNC_ENABLED=%j)", async (value) => {
    vi.stubEnv("DOCS_SYNC_ENABLED", value)
    const a = await create(WS, "Alpha")
    await updateDocument(a.id, { title: "Beta" }, { ...author, expectedRevision: a.revision! })
    await deleteDocument(a.id, { ...author, workspaceId: WS })
    expect(store.changes).toHaveLength(0)
    await expect(scanDocs(WS, {})).rejects.toBeInstanceOf(DocSyncDisabledError)
  })
})

describe("scan", () => {
  it("returns a snapshot without a cursor: STANDARD docs only, with path, revision, size and hash", async () => {
    const a = await create(WS, "Alpha")
    await create(WS, "Board", { docType: "CANVAS", content: JSON.stringify({ nodes: [], edges: [] }) })
    const scan = await scanDocs(WS, {})
    expect(scan.mode).toBe("snapshot")
    expect(scan.entries).toHaveLength(1)
    expect(scan.entries[0]).toMatchObject({ id: a.id, path: "Alpha", kind: "file", revision: a.revision })
    expect(scan.entries[0].size).toBeGreaterThan("# Alpha".length) // includes the compass_ frontmatter
    expect(scan.entries[0].hash).toMatch(/^[0-9a-f]{64}$/)
    expect(decodeSyncCursor(scan.cursor)).toBe(1)
  })

  it("marks a body-less parent as a folder", async () => {
    const parent = await createDocument({ workspaceId: WS, title: "Dir", content: null } as never, author)
    await create(WS, "Leaf", { parentId: parent.id })
    const kinds = Object.fromEntries((await scanDocs(WS, {})).entries.map((e) => [e.path, e.kind]))
    expect(kinds).toEqual({ Dir: "folder", "Dir/Leaf": "file" })
  })

  it("returns only what changed after the cursor as a delta, latest change per doc", async () => {
    const a = await create(WS, "Alpha")
    const { cursor } = await scanDocs(WS, {})
    const b = await create(WS, "Beta")
    await updateDocument(b.id, { content: "v2" }, { ...author, expectedRevision: b.revision! })
    const delta = await scanDocs(WS, { cursor })
    expect(delta.mode).toBe("delta")
    expect(delta.entries.map((e) => e.id)).toEqual([b.id])
    expect(delta.entries[0].path).toBe("Beta")
    expect(decodeSyncCursor(delta.cursor)).toBe(3)
    expect(a.id).toBeDefined()
    // Resuming from the new cursor yields nothing.
    expect(await scanDocs(WS, { cursor: delta.cursor })).toMatchObject({ mode: "delta", entries: [], hasMore: false })
  })

  it("reports a move as the same id at its new path", async () => {
    const a = await create(WS, "A")
    await create(WS, "Folder")
    const { cursor } = await scanDocs(WS, {})
    await moveDocById(WS, a.id, "Folder/A", { ...author, expectedRevision: a.revision! })
    const delta = await scanDocs(WS, { cursor })
    expect(delta.entries.map((e) => [e.id, e.path])).toEqual([[a.id, "Folder/A"]])
  })

  it("emits a tombstone with the last path for a deleted doc", async () => {
    const a = await create(WS, "Alpha")
    const { cursor } = await scanDocs(WS, {})
    await deleteDocument(a.id, { ...author, workspaceId: WS })
    const delta = await scanDocs(WS, { cursor })
    expect(delta.entries).toEqual([{ id: a.id, path: "Alpha", kind: "tombstone", revision: a.revision, size: 0, hash: null }])
    // And a fresh snapshot no longer lists it.
    expect((await scanDocs(WS, {})).entries).toEqual([])
  })

  it("a doc created then deleted inside one delta window is just a tombstone", async () => {
    const { cursor } = await scanDocs(WS, {})
    const a = await create(WS, "Fleeting")
    await deleteDocument(a.id, { ...author, workspaceId: WS })
    expect((await scanDocs(WS, { cursor })).entries.map((e) => e.kind)).toEqual(["tombstone"])
  })

  it("pages a delta with hasMore and resumes from the returned cursor", async () => {
    const { cursor } = await scanDocs(WS, {})
    for (const t of ["A", "B", "C"]) await create(WS, t)
    const first = await scanDocs(WS, { cursor, limit: 2 })
    expect(first.entries).toHaveLength(2)
    expect(first.hasMore).toBe(true)
    const second = await scanDocs(WS, { cursor: first.cursor, limit: 2 })
    expect(second.entries.map((e) => e.path)).toEqual(["C"])
    expect(second.hasMore).toBe(false)
  })

  describe("stale or absent cursors fall back to a full snapshot", () => {
    it.each([
      ["garbage", "not-a-cursor"],
      ["well-formed but foreign", Buffer.from("other:5").toString("base64url")],
      ["ahead of the log", encodeSyncCursor(999)],
    ])("%s", async (_name, cursor) => {
      await create(WS, "Alpha")
      const scan = await scanDocs(WS, { cursor })
      expect(scan.mode).toBe("snapshot")
      expect(scan.entries).toHaveLength(1)
    })

    it("older than the oldest retained change (pruned log)", async () => {
      await create(WS, "A"); await create(WS, "B"); await create(WS, "C")
      store.changes.splice(0, 2) // retention dropped seq 1 and 2
      expect((await scanDocs(WS, { cursor: encodeSyncCursor(1) })).mode).toBe("snapshot")
      expect((await scanDocs(WS, { cursor: encodeSyncCursor(2) })).mode).toBe("delta")
    })
  })

  it("keeps workspaces isolated: no entries, tombstones or seq leak across", async () => {
    const mine = await create(WS, "Mine")
    const theirs = await create(OTHER_WS, "Theirs")
    await deleteDocument(theirs.id, { ...author, workspaceId: OTHER_WS })
    const snapshot = await scanDocs(WS, {})
    expect(snapshot.entries.map((e) => e.id)).toEqual([mine.id])
    // A cursor minted for the other workspace's position is "ahead" here and cannot read its log.
    const delta = await scanDocs(WS, { cursor: encodeSyncCursor(0) })
    expect(delta.entries.map((e) => e.id)).toEqual([mine.id])
    expect(delta.entries.every((e) => e.kind !== "tombstone")).toBe(true)
  })
})
