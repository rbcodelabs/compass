/**
 * Geode doc sync, second review round: sort-order-aware "before" trees, explicit stale-continuation
 * errors, sticky partial snapshots, counter re-seeding and the flag-off epoch rotation, in-tx
 * re-read for legacy writers, change-row chunking, and conflict detection.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as syncFake from "./helpers/doc-sync-fake"
import { resetStore, store, type Row } from "./helpers/doc-sync-fake"

vi.mock("@/lib/db", () => ({ default: () => syncFake.fake }))
vi.mock("@/lib/following-hooks", () => ({ followAfterCreate: vi.fn(), mcpFollowActor: vi.fn() }))

import { createDocument, updateDocument } from "@/lib/document-service"
import { moveDocById } from "@/lib/doc-fs"
import { updateDoc } from "@/lib/doc-tool-handlers"
import { isDocChangeConflict, noteDocWriteWhileSyncOff } from "@/lib/doc-sync"
import { DocSyncContinuationStaleError, encodeSyncCursor, epochTag, scanDocs } from "@/lib/doc-sync-scan"

const WS = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const author = { authorName: "Tester" }
const create = (title: string, extra: Row = {}) => createDocument({ workspaceId: WS, title, content: `# ${title}`, ...extra } as never, author)
const tag = () => epochTag(store.counters.find((c) => c.workspaceId === WS)?.epoch ?? null)
const brokenGeodeDoc = (id: string, title: string) =>
  store.docs.push({ id, workspaceId: WS, title, parentId: null, content: null, metadata: null, roadmapItemId: null, docType: "STANDARD", sortOrder: 0, storageProvider: "GEODE", contentRef: null, icon: null, revision: "r", createdAt: new Date("2026-01-01"), updatedAt: new Date("2026-01-01") })

beforeEach(() => { resetStore(); vi.stubEnv("DOCS_SYNC_ENABLED", "1"); vi.stubEnv("DOCS_SYNC_EPOCH", "") })
afterEach(() => vi.unstubAllEnvs())

describe("sort order is part of the reconstructed 'before' tree", () => {
  it("renaming a bare-titled sibling via movePath (which changes sortOrder) re-reports the other sibling", async () => {
    const late = await create("Same", { sortOrder: 5 })
    const early = await create("Same", { sortOrder: 0 }) // sorts first => owns the bare title
    const before = Object.fromEntries((await scanDocs(WS, {})).entries.map((e) => [e.id, e.path]))
    expect(before[early.id]).toBe("Same")
    expect(before[late.id]).toMatch(/^Same \([0-9a-f]{8}\)$/)
    store.changes.length = 0
    await moveDocById(WS, early.id, "Other", { ...author, expectedRevision: early.revision! }) // title Other, sortOrder becomes last+1
    expect(store.changes.map((c) => [c.docId, c.kind, c.path])).toEqual(expect.arrayContaining([[early.id, "MOVE", "Other"], [late.id, "MOVE", "Same"]]))
  })
})

describe("stale continuation", () => {
  it("rejects a malformed token", async () => {
    await create("A")
    await expect(scanDocs(WS, { continuation: "garbage" })).rejects.toBeInstanceOf(DocSyncContinuationStaleError)
  })

  it("rejects a token whose counter was created mid-paging (tag none -> real epoch)", async () => {
    const first = await scanDocs(WS, { limit: 1 }) // empty workspace: no counter yet, but craft a paging token
    expect(first.hasMore).toBe(false)
    const token = Buffer.from(JSON.stringify({ e: "none", h: 0, a: "A", k: 0 })).toString("base64url")
    await create("A") // creates the counter, so the log tag changes
    await expect(scanDocs(WS, { continuation: token })).rejects.toBeInstanceOf(DocSyncContinuationStaleError)
  })
})

describe("partial snapshots are sticky across pages", () => {
  it("every page after a skip is partial with no checkpoint cursor, including the last", async () => {
    await create("A"); await create("C")
    brokenGeodeDoc("99999999-9999-4999-8999-999999999999", "B")
    const p1 = await scanDocs(WS, { limit: 1 })
    expect(p1).toMatchObject({ status: "complete", hasMore: true })
    expect(p1.cursor).not.toBeNull()
    const p2 = await scanDocs(WS, { continuation: p1.continuation!, limit: 1 })
    expect(p2).toMatchObject({ status: "partial", cursor: null, reason: "unreadable-doc", hasMore: true })
    expect(p2.skipped.map((s) => s.path)).toEqual(["B"])
    const p3 = await scanDocs(WS, { continuation: p2.continuation!, limit: 1 })
    expect(p3).toMatchObject({ status: "partial", cursor: null, reason: "unreadable-doc", hasMore: false, skipped: [] })
    expect(p3.entries.map((e) => e.path)).toEqual(["C"])
  })

  it("a delta whose only change is unreadable does not move the cursor and tells the client to stop", async () => {
    await create("Seed")
    const start = (await scanDocs(WS, {})).cursor!
    const seq = store.counters[0].lastSeq
    brokenGeodeDoc("99999999-9999-4999-8999-999999999999", "Broken")
    store.changes.push({ id: "c", workspaceId: WS, docId: "99999999-9999-4999-8999-999999999999", seq: seq + 1, kind: "UPSERT", revision: "r", path: "Broken", deletedAt: null, createdAt: new Date() })
    store.counters[0].lastSeq = seq + 1
    const delta = await scanDocs(WS, { cursor: start })
    expect(delta).toMatchObject({ status: "partial", hasMore: false, reason: "unreadable-doc-blocks-cursor", cursor: start })
  })
})

describe("counter row lifecycle", () => {
  it("re-seeds a deleted counter from the highest existing seq instead of colliding with the log", async () => {
    await create("A"); await create("B"); await create("C")
    const oldTag = tag()
    store.counters.length = 0 // someone deleted the counter row; change rows remain
    await expect(create("D")).resolves.toBeDefined()
    expect(store.changes.map((c) => c.seq)).toEqual([1, 2, 3, 4])
    expect(store.counters[0].lastSeq).toBe(4)
    expect(tag()).not.toBe(oldTag) // the rebuilt counter has a new epoch, so old cursors snapshot
  })

  it("flag OFF: the first doc write rotates the epoch of an existing counter exactly once", async () => {
    const a = await create("A")
    const epoch = store.counters[0].epoch
    const cursor = (await scanDocs(WS, {})).cursor!
    vi.stubEnv("DOCS_SYNC_ENABLED", "")
    await updateDocument(a.id, { content: "off 1" }, { ...author, expectedRevision: a.revision! })
    const rotated = store.counters[0].epoch
    expect(rotated).not.toBe(epoch)
    expect(store.counters[0].dirty).toBe(true)
    await updateDocument(a.id, { content: "off 2" }, author)
    expect(store.counters[0].epoch).toBe(rotated) // second off-write: no further change
    expect(store.changes).toHaveLength(1) // nothing logged while off
    vi.stubEnv("DOCS_SYNC_ENABLED", "1")
    expect((await scanDocs(WS, { cursor })).mode).toBe("snapshot") // the old checkpoint cannot be reused
    const b = await create("B")
    expect(store.counters[0].dirty).toBe(false)
    expect(store.counters[0].epoch).toBe(rotated) // the logged write only clears the marker
    expect(b.id).toBeDefined()
  })

  it("flag OFF with no counter: nothing is created", async () => {
    vi.stubEnv("DOCS_SYNC_ENABLED", "")
    await create("A")
    expect(store.counters).toHaveLength(0)
    expect(store.changes).toHaveLength(0)
  })

  it("flag-off bookkeeping never fails a write, even when the table is missing", async () => {
    const broken = { docChangeCounter: { updateMany: async () => { throw new Error('relation "doc_change_counters" does not exist') } } }
    vi.stubEnv("DOCS_SYNC_ENABLED", "")
    await expect(noteDocWriteWhileSyncOff(broken as never, WS)).resolves.toBeUndefined()
  })
})

describe("legacy writers read 'before' inside the retried transaction", () => {
  it("update_doc diffs against the row as of the retry, not the pre-conflict read", async () => {
    const a = await create("A")
    store.onFirstLock = () => () => { store.docs.find((d) => d.id === a.id)!.title = "ChangedByOther" }
    await updateDoc({ docId: a.id, title: "A" })
    expect(store.changes.at(-1)).toMatchObject({ docId: a.id, kind: "MOVE", path: "A" })
  })
})

describe("large subtree moves", () => {
  it("writes change rows in chunks of at most 500", async () => {
    const parent = await create("Parent")
    for (let i = 0; i < 1100; i++) {
      store.docs.push({ id: `55555555-5555-4555-8555-${String(i).padStart(12, "0")}`, workspaceId: WS, title: `Kid ${i}`, parentId: parent.id, content: "x", metadata: null, roadmapItemId: null, docType: "STANDARD", sortOrder: i, storageProvider: null, contentRef: null, icon: null, revision: "r", createdAt: new Date("2026-01-01"), updatedAt: new Date("2026-01-01") })
    }
    store.createManySizes.length = 0
    await updateDocument(parent.id, { title: "Renamed" }, { ...author, expectedRevision: parent.revision! })
    expect(store.createManySizes).toEqual([500, 500, 101])
  })
})

describe("isDocChangeConflict", () => {
  it("recognises codes wherever the driver put them", () => {
    expect(isDocChangeConflict({ meta: { driverAdapterError: { cause: { originalCode: "40001" } } } })).toBe(true)
    expect(isDocChangeConflict({ originalCode: "OC000" })).toBe(true)
    expect(isDocChangeConflict({ cause: { cause: { code: "40P01" } } })).toBe(true)
    expect(isDocChangeConflict(new Error("change conflicts: OC001 on table"))).toBe(true)
    expect(isDocChangeConflict(new Error("could not serialize access due to concurrent update"))).toBe(true)
  })

  it("recognises a lost counter-row insert but not other unique violations", () => {
    expect(isDocChangeConflict({ code: "P2002", meta: { modelName: "DocChangeCounter" } })).toBe(true)
    expect(isDocChangeConflict({ code: "P2002", meta: { target: ["workspace_id"], driverAdapterError: { cause: { constraint: "doc_change_counters_pkey" } } }, message: 'duplicate key "doc_change_counters_pkey"' })).toBe(true)
    expect(isDocChangeConflict({ code: "23505", message: 'duplicate key value violates unique constraint "doc_change_counters_pkey"' })).toBe(true)
    expect(isDocChangeConflict({ code: "P2002", meta: { modelName: "Doc", target: ["roadmap_item_id"] } })).toBe(false)
  })

  it("ignores incidental numbers and unrelated errors", () => {
    expect(isDocChangeConflict(new Error("order 40001 not found"))).toBe(false)
    expect(isDocChangeConflict(new Error("revision-conflict"))).toBe(false)
    expect(isDocChangeConflict(null)).toBe(false)
  })
})

void encodeSyncCursor
