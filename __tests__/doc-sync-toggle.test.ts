/**
 * Flag toggling and mixed-flag rolling deploys: a checkpoint (cursor) must never survive doc writes
 * made while sync was off, and every doc transaction must take the counter lock before touching doc rows.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as syncFake from "./helpers/doc-sync-fake"
import { resetStore, store, type Row } from "./helpers/doc-sync-fake"

vi.mock("@/lib/db", () => ({ default: () => syncFake.fake }))
vi.mock("@/lib/following-hooks", () => ({ followAfterCreate: vi.fn(), mcpFollowActor: vi.fn() }))

import { createDocument, deleteDocument, snapshotDocument, updateDocument } from "@/lib/document-service"
import { decodeSyncCursor, epochTag, scanDocs } from "@/lib/doc-sync-scan"
import { touchEndpoint } from "@/lib/links/endpoints"

const WS = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const author = { authorName: "Tester" }
const create = (title: string, extra: Row = {}) => createDocument({ workspaceId: WS, title, content: `# ${title}`, ...extra } as never, author)
const flag = (on: boolean) => vi.stubEnv("DOCS_SYNC_ENABLED", on ? "1" : "")
const counter = () => store.counters.find((c) => c.workspaceId === WS)!

beforeEach(() => { resetStore(); flag(true); vi.stubEnv("DOCS_SYNC_EPOCH", "") })
afterEach(() => vi.unstubAllEnvs())

describe("dirty marker is cleared when a scan issues a checkpoint", () => {
  it("off-write, on, snapshot, off, off-write, on: the old checkpoint is rejected", async () => {
    const a = await create("A")
    flag(false)
    await updateDocument(a.id, { content: "off 1" }, author)
    const e2 = counter().epoch
    expect(counter().dirty).toBe(true)
    flag(true)
    const snapshot = await scanDocs(WS, {})
    expect(snapshot.mode).toBe("snapshot")
    expect(counter()).toMatchObject({ epoch: e2, dirty: false }) // acknowledged: the next off-write must rotate again
    flag(false)
    await updateDocument(a.id, { content: "off 2" }, author)
    expect(counter().epoch).not.toBe(e2)
    flag(true)
    expect((await scanDocs(WS, { cursor: snapshot.cursor })).mode).toBe("snapshot") // not an empty delta
  })

  it("rolling deploy: a flag-off instance writes after a flag-on instance issued a cursor", async () => {
    const a = await create("A")
    const issued = (await scanDocs(WS, {})).cursor
    // A flag-off instance handles a write while flag-on instances still serve scans.
    flag(false)
    await updateDocument(a.id, { content: "from the old instance" }, author)
    flag(true)
    expect((await scanDocs(WS, { cursor: issued })).mode).toBe("snapshot")
  })

  it("a delta scan acknowledges too", async () => {
    const a = await create("A")
    flag(false)
    await updateDocument(a.id, { content: "off" }, author)
    flag(true)
    const first = await scanDocs(WS, {})
    flag(false)
    await updateDocument(a.id, { content: "off again" }, author)
    flag(true)
    const second = await scanDocs(WS, { cursor: first.cursor }) // stale => snapshot, issues a fresh checkpoint
    expect(second.mode).toBe("snapshot")
    expect(counter().dirty).toBe(false)
    expect((await scanDocs(WS, { cursor: second.cursor })).mode).toBe("delta")
  })

  it("does not undo a rotation that raced in after the scan read the counter", async () => {
    await create("A")
    const before = counter().epoch
    store.counters[0].dirty = true
    // The scan reads epoch `before`; a flag-off writer rotates to a new epoch before the acknowledgement lands.
    const realFind = syncFake.fake.docChangeCounter.findUnique
    syncFake.fake.docChangeCounter.findUnique = async (args: Row) => { const row = await realFind(args); store.counters[0].epoch = "rotated-by-old-instance"; store.counters[0].dirty = true; return row }
    try { await scanDocs(WS, {}) } finally { syncFake.fake.docChangeCounter.findUnique = realFind }
    expect(counter()).toMatchObject({ epoch: "rotated-by-old-instance", dirty: true })
    expect(before).not.toBe("rotated-by-old-instance")
  })
})

describe("a scan never issues an epoch-less checkpoint", () => {
  it("creates the counter row (race-safe) and issues a cursor with a real epoch", async () => {
    await create("A")
    store.counters.length = 0
    const [one, two] = await Promise.all([scanDocs(WS, {}), scanDocs(WS, {})])
    expect(store.counters).toHaveLength(1)
    expect(decodeSyncCursor(one.cursor!)?.tag).toBe(epochTag(counter().epoch))
    expect(decodeSyncCursor(two.cursor!)?.tag).toBe(epochTag(counter().epoch))
  })

  it("seeds a scan-created counter from the existing log", async () => {
    await create("A"); await create("B")
    store.counters.length = 0
    await scanDocs(WS, {})
    expect(counter().lastSeq).toBe(2)
  })

  it("no counter, scan, flag off, edit, flag on: the old cursor is rejected", async () => {
    const a = store.docs[store.docs.push({ id: "77777777-7777-4777-8777-777777777777", workspaceId: WS, title: "Pre-existing", parentId: null, content: "x", metadata: null, roadmapItemId: null, docType: "STANDARD", sortOrder: 0, storageProvider: null, contentRef: null, icon: null, revision: "r0", createdAt: new Date("2026-01-01"), updatedAt: new Date("2026-01-01") }) - 1]
    expect(store.counters).toHaveLength(0)
    const issued = (await scanDocs(WS, {})).cursor
    expect(store.counters).toHaveLength(1)
    flag(false)
    await updateDocument(a.id, { content: "edited while off" }, author)
    flag(true)
    expect((await scanDocs(WS, { cursor: issued })).mode).toBe("snapshot")
  })

  it("the legacy 'none' tag is no longer a valid cursor", async () => {
    await create("A")
    const legacy = Buffer.from("dsc1:none:0").toString("base64url")
    expect(decodeSyncCursor(legacy)).toBeNull()
    expect((await scanDocs(WS, { cursor: legacy })).mode).toBe("snapshot")
  })
})

describe("lock order: counter first, then doc rows", () => {
  const firstLockBeforeDocWrite = () => {
    const lock = store.trace.indexOf("lock")
    const write = store.trace.indexOf("doc-write")
    expect(lock).toBeGreaterThanOrEqual(0)
    expect(write).toBeGreaterThan(lock)
  }

  it("create", async () => { await create("A"); firstLockBeforeDocWrite() })

  it("update with expectedRevision", async () => {
    const a = await create("A"); store.trace.length = 0
    await updateDocument(a.id, { content: "x" }, { ...author, expectedRevision: a.revision! })
    firstLockBeforeDocWrite()
  })

  it("update without a revision (last-write-wins)", async () => {
    const a = await create("A"); store.trace.length = 0
    await updateDocument(a.id, { content: "x" }, author)
    firstLockBeforeDocWrite()
  })

  it("delete", async () => {
    const a = await create("A"); store.trace.length = 0
    await deleteDocument(a.id, { ...author, workspaceId: WS })
    firstLockBeforeDocWrite()
  })

  it("guarded snapshot", async () => {
    store.docs.push({ id: "88888888-8888-4888-8888-888888888888", workspaceId: WS, title: "Legacy", parentId: null, content: "x", metadata: null, roadmapItemId: null, docType: "STANDARD", sortOrder: 0, storageProvider: null, contentRef: null, icon: null, revision: null, createdAt: new Date("2026-01-01"), updatedAt: new Date("2026-01-01") })
    const legacy = store.docs[0]
    await snapshotDocument(legacy.id, { ...author, operationId: "11111111-1111-4111-8111-111111111111", expectedRevision: `legacy:${legacy.updatedAt.toISOString()}` })
    firstLockBeforeDocWrite()
  })

  it("link touch of a pre-revision doc", async () => {
    store.docs.push({ id: "66666666-6666-4666-8666-666666666666", workspaceId: WS, title: "Legacy", parentId: null, content: "x", metadata: null, roadmapItemId: null, docType: "STANDARD", sortOrder: 0, storageProvider: null, contentRef: null, icon: null, revision: null, createdAt: new Date("2026-01-01"), updatedAt: new Date("2026-01-01") })
    const tx = { ...syncFake.fake, $transaction: undefined } as never
    // run inside a journaled transaction so the fake traces lock and doc-write
    await syncFake.fake.$transaction(async (inner: Row) => { await touchEndpoint(inner as never, "DOC", WS, "66666666-6666-4666-8666-666666666666") })
    void tx
    firstLockBeforeDocWrite()
  })
})
