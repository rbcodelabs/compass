/**
 * Geode doc sync spike: change-log writes (inside the mutation's transaction), the scan's
 * snapshot/delta/tombstone/staleness behaviour, the flag-off no-op, and workspace isolation.
 * Runs the REAL document-service and doc-sync code against a small in-memory Prisma fake.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as syncFake from "./helpers/doc-sync-fake"
import { resetStore, store, type Row } from "./helpers/doc-sync-fake"

vi.mock("@/lib/db", () => ({ default: () => syncFake.fake }))
vi.mock("@/lib/following-hooks", () => ({ followAfterCreate: vi.fn(), mcpFollowActor: vi.fn() }))

import { createDocument, deleteDocument, updateDocument } from "@/lib/document-service"
import { moveDocById } from "@/lib/doc-fs"
import { isDocChangeConflict, withDocChangeRetry } from "@/lib/doc-sync"
import { decodeSyncCursor, encodeSyncCursor, epochTag, scanDocs, DocSyncDisabledError } from "@/lib/doc-sync-scan"

const WS = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const OTHER_WS = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const author = { authorName: "Tester" }
const changesFor = (workspaceId: string) => store.changes.filter((c) => c.workspaceId === workspaceId)
const tagOf = (workspaceId: string) => epochTag(store.counters.find((c) => c.workspaceId === workspaceId)?.epoch ?? null)
const cursorAt = (seq: number, workspaceId = WS) => encodeSyncCursor(seq, tagOf(workspaceId))
const create = (workspaceId: string, title: string, extra: Row = {}) => createDocument({ workspaceId, title, content: `# ${title}`, ...extra } as never, author)

beforeEach(() => {
  resetStore()
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
    expect(store.changes.map((c) => c.seq)).toEqual([4, 5]) // 1 parent, 2 child, 3 parent file->folder flip
  })

  it("records a doc-fs move (reparent) as MOVE at the new path", async () => {
    const a = await create(WS, "A")
    const folder = await create(WS, "Folder")
    store.changes.length = 0
    await moveDocById(WS, a.id, "Folder/A", { ...author, expectedRevision: a.revision! })
    // A moves; Folder becomes a parent, so it is re-reported too (its file/folder kind flipped).
    expect(store.changes.map((c) => [c.docId, c.kind, c.path])).toEqual([[folder.id, "UPSERT", "Folder"], [a.id, "MOVE", "Folder/A"]])
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

describe("seq allocation under concurrent writers", () => {
  it("never fails either mutation and hands out distinct, gap-free, monotonic seqs", async () => {
    const a = await create(WS, "A")
    const b = await create(WS, "B")
    store.conflicts = 0
    const [ua, ub] = await Promise.all([
      updateDocument(a.id, { content: "a2" }, { ...author, expectedRevision: a.revision! }),
      updateDocument(b.id, { content: "b2" }, { ...author, expectedRevision: b.revision! }),
    ])
    expect(store.conflicts).toBeGreaterThanOrEqual(1) // the simulated optimistic-concurrency conflict really happened
    expect([ua.content, ub.content]).toEqual(["a2", "b2"])
    expect(changesFor(WS).map((c) => c.seq)).toEqual([1, 2, 3, 4])
    expect(new Set(changesFor(WS).map((c) => c.seq)).size).toBe(4)
    expect(store.counters.find((c) => c.workspaceId === WS)!.lastSeq).toBe(4)
    // A retried transaction must not leave a duplicate change row behind.
    expect(changesFor(WS).filter((c) => c.docId === a.id)).toHaveLength(2)
  })

  it("survives several simultaneous creators", async () => {
    const docs = await Promise.all(["A", "B", "C", "D"].map((t) => create(WS, t)))
    expect(docs).toHaveLength(4)
    expect(changesFor(WS).map((c) => c.seq).sort()).toEqual([1, 2, 3, 4])
  })

  it("does not retry conflicts when sync is off, and never retries other errors", async () => {
    const conflict = Object.assign(new Error("boom"), { code: "P2034" })
    vi.stubEnv("DOCS_SYNC_ENABLED", "")
    let calls = 0
    await expect(withDocChangeRetry(async () => { calls++; throw conflict })).rejects.toBe(conflict)
    expect(calls).toBe(1)
    vi.stubEnv("DOCS_SYNC_ENABLED", "1")
    calls = 0
    await expect(withDocChangeRetry(async () => { calls++; throw new Error("plain") })).rejects.toThrow("plain")
    expect(calls).toBe(1)
    calls = 0
    await expect(withDocChangeRetry(async () => { calls++; throw conflict })).rejects.toBe(conflict) // bounded
    expect(calls).toBe(6)
  })

  it("recognises Postgres and DSQL conflict signals", () => {
    expect(isDocChangeConflict({ code: "P2034" })).toBe(true)
    expect(isDocChangeConflict({ code: "40001" })).toBe(true)
    expect(isDocChangeConflict(new Error("ERROR: OC000 change conflicts with another transaction"))).toBe(true)
    expect(isDocChangeConflict({ cause: { code: "40001" } })).toBe(true)
    expect(isDocChangeConflict(new Error("revision-conflict"))).toBe(false)
    expect(isDocChangeConflict(new Error("unique constraint"))).toBe(false)
  })
})

describe("sibling collision-suffix path changes", () => {
  it("logs the sibling whose '(suffix)' disappears when the doc ahead of it is renamed", async () => {
    const first = await create(WS, "Same")
    const second = await create(WS, "Same")
    const before = (await scanDocs(WS, {})).entries.map((e) => e.path).sort()
    expect(before).toEqual(["Same", expect.stringMatching(/^Same \([0-9a-f]{8}\)$/)].sort())
    const { cursor } = await scanDocs(WS, {})
    await updateDocument(first.id, { title: "Other" }, { ...author, expectedRevision: first.revision! })
    const delta = await scanDocs(WS, { cursor })
    expect(Object.fromEntries(delta.entries.map((e) => [e.id, e.path]))).toEqual({ [first.id]: "Other", [second.id]: "Same" })
  })

  it("logs the surviving sibling (and its children) when the bare-titled doc is deleted", async () => {
    const first = await create(WS, "Same")
    const second = await create(WS, "Same")
    const child = await create(WS, "Kid", { parentId: second.id })
    const { cursor } = await scanDocs(WS, {})
    await deleteDocument(first.id, { ...author, workspaceId: WS })
    const delta = await scanDocs(WS, { cursor })
    const byId = Object.fromEntries(delta.entries.map((e) => [e.id, [e.kind, e.path]]))
    expect(byId).toEqual({ [first.id]: ["tombstone", "Same"], [second.id]: ["file", "Same"], [child.id]: ["file", "Same/Kid"] })
  })

  it("writes nothing extra when no sibling shares the title", async () => {
    await create(WS, "Solo")
    const other = await create(WS, "Other")
    store.changes.length = 0
    await updateDocument(other.id, { title: "Renamed" }, { ...author, expectedRevision: other.revision! })
    expect(store.changes).toHaveLength(1)
  })
})

describe("flag off", () => {
  it.each(["", "0", "false"])("writes no change rows and the scan is disabled (DOCS_SYNC_ENABLED=%j)", async (value) => {
    vi.stubEnv("DOCS_SYNC_ENABLED", value)
    const a = await create(WS, "Alpha")
    await updateDocument(a.id, { title: "Beta" }, { ...author, expectedRevision: a.revision! })
    await deleteDocument(a.id, { ...author, workspaceId: WS })
    expect(store.changes).toHaveLength(0)
    expect(store.counters).toHaveLength(0)
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
    expect(decodeSyncCursor(scan.cursor!)?.seq).toBe(1)
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
    expect(decodeSyncCursor(delta.cursor!)?.seq).toBe(3)
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
    expect(delta.entries.map((e) => [e.path, e.kind])).toEqual([["Folder", "file"], ["Folder/A", "file"]])
    expect(delta.entries.map((e) => e.id)).toContain(a.id)
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
    await create(WS, "Seed")
    const { cursor } = await scanDocs(WS, {})
    const a = await create(WS, "Fleeting")
    await deleteDocument(a.id, { ...author, workspaceId: WS })
    expect((await scanDocs(WS, { cursor })).entries.map((e) => e.kind)).toEqual(["tombstone"])
  })

  it("pages a delta with hasMore and resumes from the returned cursor", async () => {
    await create(WS, "Seed")
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
      ["ahead of the log", "AHEAD"],
      ["from another workspace's log", "OTHER"],
    ])("%s", async (_name, kind) => {
      await create(WS, "Alpha")
      await create(OTHER_WS, "Elsewhere")
      const cursor = kind === "AHEAD" ? cursorAt(999) : kind === "OTHER" ? cursorAt(1, OTHER_WS) : kind
      const scan = await scanDocs(WS, { cursor })
      expect(scan.mode).toBe("snapshot")
      expect(scan.entries).toHaveLength(1)
    })

    it("older than the oldest retained change (pruned log)", async () => {
      await create(WS, "A"); await create(WS, "B"); await create(WS, "C")
      store.changes.splice(0, 2) // retention dropped seq 1 and 2
      expect((await scanDocs(WS, { cursor: cursorAt(1) })).mode).toBe("snapshot")
      expect((await scanDocs(WS, { cursor: cursorAt(2) })).mode).toBe("delta")
    })
  })

  it("keeps workspaces isolated: no entries, tombstones or seq leak across", async () => {
    const mine = await create(WS, "Mine")
    const theirs = await create(OTHER_WS, "Theirs")
    await deleteDocument(theirs.id, { ...author, workspaceId: OTHER_WS })
    const snapshot = await scanDocs(WS, {})
    expect(snapshot.entries.map((e) => e.id)).toEqual([mine.id])
    // A cursor minted for the other workspace carries its epoch, so it cannot read this log: full snapshot.
    const foreign = await scanDocs(WS, { cursor: cursorAt(0, OTHER_WS) })
    expect(foreign.mode).toBe("snapshot")
    expect(foreign.entries.map((e) => e.id)).toEqual([mine.id])
    expect(foreign.entries.every((e) => e.kind !== "tombstone")).toBe(true)
  })
})
