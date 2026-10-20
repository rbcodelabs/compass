/**
 * Geode doc sync, review round: v1 scope (STANDARD docs with no CANVAS/GTM ancestor), file/folder
 * flips, log epoch, snapshot paging, narrow reads, per-doc read failures, and lock-first ordering.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as syncFake from "./helpers/doc-sync-fake"
import { resetStore, store, type Row } from "./helpers/doc-sync-fake"

vi.mock("@/lib/db", () => ({ default: () => syncFake.fake }))
vi.mock("@/lib/following-hooks", () => ({ followAfterCreate: vi.fn(), mcpFollowActor: vi.fn() }))

import { createDocument, deleteDocument, snapshotDocument, updateDocument } from "@/lib/document-service"
import { encodeSyncCursor, epochTag, scanDocs } from "@/lib/doc-sync-scan"

const WS = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const author = { authorName: "Tester" }
const canvasBody = JSON.stringify({ nodes: [], edges: [] })
const create = (title: string, extra: Row = {}) => createDocument({ workspaceId: WS, title, content: `# ${title}`, ...extra } as never, author)
const rename = (doc: { id: string; revision: string | null }, change: Row) => updateDocument(doc.id, change, { ...author, expectedRevision: doc.revision! })
const move = (doc: { id: string; revision: string | null }, parentId: string | null) => rename(doc, { parentId })
const tag = () => epochTag(store.counters.find((c) => c.workspaceId === WS)?.epoch ?? null)
const rows = () => store.changes.map((c) => [c.docId, c.kind, c.path])

beforeEach(() => { resetStore(); vi.stubEnv("DOCS_SYNC_ENABLED", "1"); vi.stubEnv("DOCS_SYNC_EPOCH", "") })
afterEach(() => vi.unstubAllEnvs())

describe("scope: STANDARD docs without a non-STANDARD ancestor", () => {
  it("excludes docs under a canvas from the snapshot", async () => {
    const board = await create("Board", { docType: "CANVAS", content: canvasBody })
    await create("Under", { parentId: board.id })
    const free = await create("Free")
    const scan = await scanDocs(WS, {})
    expect(scan.entries.map((e) => e.id)).toEqual([free.id])
  })

  it("creating a doc under a canvas logs nothing", async () => {
    const board = await create("Board", { docType: "CANVAS", content: canvasBody })
    store.changes.length = 0
    await create("Under", { parentId: board.id })
    expect(store.changes).toHaveLength(0)
  })

  it("moving a doc (and its subtree) under a canvas emits tombstones; moving it back emits upserts", async () => {
    const board = await create("Board", { docType: "CANVAS", content: canvasBody })
    const top = await create("Top")
    const kid = await create("Kid", { parentId: top.id })
    await scanDocs(WS, {})
    const cursor = encodeSyncCursor(store.counters[0].lastSeq, tag())

    const moved = await move(top, board.id)
    const gone = await scanDocs(WS, { cursor })
    expect(gone.entries.map((e) => [e.id, e.kind, e.path]).sort()).toEqual([[kid.id, "tombstone", "Top/Kid"], [top.id, "tombstone", "Top"]].sort())
    expect(store.changes.filter((c) => c.kind === "DELETE").every((c) => c.deletedAt instanceof Date)).toBe(true)

    const cursor2 = gone.cursor
    await move(moved, null)
    const back = await scanDocs(WS, { cursor: cursor2 })
    expect(back.entries.map((e) => [e.id, e.kind, e.path]).sort()).toEqual([[kid.id, "file", "Top/Kid"], [top.id, "file", "Top"]].sort())
  })

  it("collision suffixes only consider in-scope siblings", async () => {
    await create("Same", { docType: "CANVAS", content: canvasBody }) // would win the bare title in doc-fs order
    const standard = await create("Same")
    const scan = await scanDocs(WS, {})
    expect(scan.entries).toMatchObject([{ id: standard.id, path: "Same" }])
  })

  it("renaming or deleting an out-of-scope sibling changes nothing in scope", async () => {
    const canvas = await create("Same", { docType: "CANVAS", content: canvasBody })
    await create("Same")
    store.changes.length = 0
    await rename(canvas, { title: "Elsewhere" })
    await deleteDocument(canvas.id, { ...author, workspaceId: WS })
    expect(store.changes).toHaveLength(0)
  })
})

describe("file <-> folder flips of body-less parents", () => {
  const parentless = () => createDocument({ workspaceId: WS, title: "Dir", content: null } as never, author)

  it("first child created: the parent is re-reported as a folder", async () => {
    const dir = await parentless()
    expect((await scanDocs(WS, {})).entries).toMatchObject([{ path: "Dir", kind: "file" }])
    const cursor = encodeSyncCursor(store.counters[0].lastSeq, tag())
    await create("Leaf", { parentId: dir.id })
    const delta = await scanDocs(WS, { cursor })
    expect(Object.fromEntries(delta.entries.map((e) => [e.path, e.kind]))).toEqual({ Dir: "folder", "Dir/Leaf": "file" })
  })

  it("last child deleted: the parent is re-reported as a file", async () => {
    const dir = await parentless()
    const leaf = await create("Leaf", { parentId: dir.id })
    const cursor = encodeSyncCursor(store.counters[0].lastSeq, tag())
    await deleteDocument(leaf.id, { ...author, workspaceId: WS })
    const delta = await scanDocs(WS, { cursor })
    expect(Object.fromEntries(delta.entries.map((e) => [e.path, e.kind]))).toEqual({ Dir: "file", "Dir/Leaf": "tombstone" })
  })

  it("child moved between parents: both the old and the new parent are re-reported", async () => {
    const from = await parentless()
    const to = await createDocument({ workspaceId: WS, title: "To", content: null } as never, author)
    const leaf = await create("Leaf", { parentId: from.id })
    const cursor = encodeSyncCursor(store.counters[0].lastSeq, tag())
    await move(leaf, to.id)
    const delta = await scanDocs(WS, { cursor })
    expect(Object.fromEntries(delta.entries.map((e) => [e.path, e.kind]))).toEqual({ Dir: "file", To: "folder", "To/Leaf": "file" })
  })
})

describe("log epoch", () => {
  it("a cursor from before DOCS_SYNC_EPOCH changed gets a snapshot", async () => {
    await create("A")
    const { cursor } = await scanDocs(WS, {})
    expect((await scanDocs(WS, { cursor })).mode).toBe("delta")
    vi.stubEnv("DOCS_SYNC_EPOCH", "2026-10-21")
    expect((await scanDocs(WS, { cursor })).mode).toBe("snapshot")
  })

  it("a rebuilt log (counter row recreated) invalidates old cursors", async () => {
    await create("A")
    const { cursor } = await scanDocs(WS, {})
    store.counters.length = 0
    store.changes.length = 0
    await create("B")
    const scan = await scanDocs(WS, { cursor })
    expect(scan.mode).toBe("snapshot")
    expect(scan.entries.map((e) => e.path).sort()).toEqual(["A", "B"].sort())
  })

  it("is generated once per workspace log and reused by later writes", async () => {
    await create("A")
    const epoch = store.counters[0].epoch
    await create("B")
    expect(store.counters[0].epoch).toBe(epoch)
    expect(epoch).toMatch(/^[0-9a-f-]{36}$/)
  })
})

describe("snapshot paging and read cost", () => {
  it("pages in path order with a continuation and one stable delta cursor", async () => {
    for (const t of ["E", "B", "D", "A", "C"]) await create(t)
    const first = await scanDocs(WS, { limit: 2 })
    expect(first).toMatchObject({ mode: "snapshot", status: "complete", hasMore: true })
    expect(first.entries.map((e) => e.path)).toEqual(["A", "B"])
    const second = await scanDocs(WS, { continuation: first.continuation!, limit: 2 })
    expect(second.entries.map((e) => e.path)).toEqual(["C", "D"])
    const third = await scanDocs(WS, { continuation: second.continuation!, limit: 2 })
    expect(third.entries.map((e) => e.path)).toEqual(["E"])
    expect(third.hasMore).toBe(false)
    expect(third.continuation).toBeNull()
    expect(new Set([first.cursor, second.cursor, third.cursor]).size).toBe(1)
    expect((await scanDocs(WS, { cursor: third.cursor })).mode).toBe("delta")
  })

  it("a change made while paging is re-delivered by the delta from the snapshot cursor", async () => {
    const a = await create("A"); await create("B"); await create("C")
    const first = await scanDocs(WS, { limit: 1 })
    await rename(a, { content: "edited mid-paging" })
    let page = first
    while (page.hasMore) page = await scanDocs(WS, { continuation: page.continuation!, limit: 1 })
    const delta = await scanDocs(WS, { cursor: first.cursor })
    expect(delta.entries.map((e) => e.id)).toEqual([a.id])
  })

  it("a continuation from another log epoch restarts the snapshot", async () => {
    await create("A"); await create("B")
    const first = await scanDocs(WS, { limit: 1 })
    vi.stubEnv("DOCS_SYNC_EPOCH", "next")
    const restarted = await scanDocs(WS, { continuation: first.continuation!, limit: 1 })
    expect(restarted.entries.map((e) => e.path)).toEqual(["A"])
  })

  it("builds the tree from narrow rows and loads bodies only for the emitted page", async () => {
    for (const t of ["A", "B", "C"]) await create(t)
    store.docFindManyArgs.length = 0
    const scan = await scanDocs(WS, { limit: 2 })
    const [tree, bodies, ...rest] = store.docFindManyArgs
    expect(rest).toHaveLength(0)
    expect(Object.keys(tree.select)).not.toContain("content")
    expect(Object.keys(tree.select)).not.toContain("metadata")
    expect(bodies.where.id.in).toEqual(scan.entries.map((e) => e.id))
    expect(bodies.where.id.in).toHaveLength(2)
  })
})

describe("per-doc read failures", () => {
  const geodeWithoutReference = () => {
    store.docs.push({ id: "99999999-9999-4999-8999-999999999999", workspaceId: WS, title: "Broken", parentId: null, content: null, metadata: null, roadmapItemId: null, docType: "STANDARD", sortOrder: 0, storageProvider: "GEODE", contentRef: null, icon: null, revision: "r", createdAt: new Date("2026-01-01"), updatedAt: new Date("2026-01-01") })
    return "99999999-9999-4999-8999-999999999999"
  }

  it("a snapshot reports the unreadable doc in `skipped`, returns the rest, and is partial", async () => {
    const ok = await create("Fine")
    const broken = geodeWithoutReference()
    const scan = await scanDocs(WS, {})
    expect(scan.status).toBe("partial")
    expect(scan.entries.map((e) => e.id)).toEqual([ok.id])
    expect(scan.skipped).toEqual([{ id: broken, path: "Broken", error: "invalid-reference" }])
  })

  it("a partial delta does not advance the cursor past the change it could not deliver", async () => {
    await create("Seed")
    const start = (await scanDocs(WS, {})).cursor
    const startSeq = store.counters[0].lastSeq
    await create("Good")
    const broken = geodeWithoutReference()
    store.changes.push({ id: "c", workspaceId: WS, docId: broken, seq: startSeq + 2, kind: "UPSERT", revision: "r", path: "Broken", deletedAt: null, createdAt: new Date() })
    store.counters[0].lastSeq = startSeq + 2
    const delta = await scanDocs(WS, { cursor: start })
    expect(delta.status).toBe("partial")
    expect(delta.entries.map((e) => e.path)).toEqual(["Good"])
    expect(delta.skipped.map((s) => s.id)).toEqual([broken])
    expect(delta.cursor).toBe(encodeSyncCursor(startSeq + 1, tag()))
  })
})

describe("transaction ordering and retries", () => {
  it("locks the counter before reading the doc tree", async () => {
    const a = await create("A")
    store.trace.length = 0
    await rename(a, { content: "x" })
    const lock = store.trace.indexOf("lock")
    const tree = store.trace.indexOf("tree")
    expect(lock).toBeGreaterThanOrEqual(0)
    expect(lock).toBeLessThan(tree)
  })

  it("last-write-wins updates re-read title/parent after a conflict retry", async () => {
    const a = await create("A")
    store.onFirstLock = () => () => { store.docs.find((d) => d.id === a.id)!.title = "ChangedByOther" } // a concurrent rename commits while the first attempt rolls back
    await updateDocument(a.id, { title: "A" }, author) // no expectedRevision: last-write-wins
    expect(store.changes.at(-1)).toMatchObject({ docId: a.id, kind: "MOVE", path: "A" }) // a stale `before` ("A") would have logged UPSERT
  })

  it("snapshotDocument logs an UPSERT when it replaces a null revision", async () => {
    store.docs.push({ id: "88888888-8888-4888-8888-888888888888", workspaceId: WS, title: "Legacy", parentId: null, content: "x", metadata: null, roadmapItemId: null, docType: "STANDARD", sortOrder: 0, storageProvider: null, contentRef: null, icon: null, revision: null, createdAt: new Date("2026-01-01"), updatedAt: new Date("2026-01-01") })
    const legacy = store.docs[0]
    await snapshotDocument(legacy.id, { ...author, operationId: "11111111-1111-4111-8111-111111111111", expectedRevision: `legacy:${legacy.updatedAt.toISOString()}` })
    expect(rows()).toEqual([[legacy.id, "UPSERT", "Legacy"]])
    expect(store.changes[0].revision).toBe(legacy.revision)
  })
})
