/**
 * Doc writers that bypass lib/document-service.ts (MCP create_doc / update_doc / metadata update
 * without an operationId, the legacy version restore, and the link-system updatedAt touch) must
 * write a doc_changes row in the same transaction while DOCS_SYNC_ENABLED is on, and behave exactly
 * as before while it is off.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as syncFake from "./helpers/doc-sync-fake"
import { resetStore, store } from "./helpers/doc-sync-fake"

vi.mock("@/lib/db", () => ({ default: () => syncFake.fake }))
vi.mock("@/lib/following-hooks", () => ({ followAfterCreate: vi.fn(), mcpFollowActor: vi.fn() }))

import { createDoc, updateDoc, updateDocMetadata } from "@/lib/doc-tool-handlers"
import { restoreDocVersionCore } from "@/lib/doc-versions"
import { touchEndpoint } from "@/lib/links/endpoints"

const WS = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const seed = (row: Record<string, unknown>) => {
  const doc = { id: `11111111-1111-4111-8111-${String(++store.ids).padStart(12, "0")}`, workspaceId: WS, title: "Seed", parentId: null, content: "body", metadata: null, roadmapItemId: null, docType: "STANDARD", sortOrder: 0, storageProvider: null, contentRef: null, icon: null, revision: "rev-0", createdAt: new Date("2026-01-01"), updatedAt: new Date("2026-01-01"), ...row }
  store.docs.push(doc)
  return doc as typeof doc & { id: string }
}

beforeEach(() => { resetStore(); vi.stubEnv("DOCS_SYNC_ENABLED", "1") })
afterEach(() => vi.unstubAllEnvs())

describe("legacy MCP handlers (no operationId)", () => {
  it("create_doc logs an UPSERT", async () => {
    const result = await createDoc({ workspaceId: WS, title: "Fresh", content: "hello" })
    expect(result.structuredContent.ok).toBe(true)
    expect(store.changes).toHaveLength(1)
    expect(store.changes[0]).toMatchObject({ workspaceId: WS, kind: "UPSERT", path: "Fresh", seq: 1 })
    expect(store.changes[0].docId).toBe(store.docs[0].id)
  })

  it("update_doc logs an UPSERT for a content edit and a MOVE for a rename", async () => {
    const doc = seed({})
    await updateDoc({ docId: doc.id, content: "changed" })
    await updateDoc({ docId: doc.id, title: "Renamed" })
    expect(store.changes.map((c) => [c.seq, c.kind, c.path])).toEqual([[1, "UPSERT", "Seed"], [2, "MOVE", "Renamed"]])
    expect(store.changes[1].revision).toBe(store.docs[0].revision)
  })

  it("update_doc metadata logs an UPSERT", async () => {
    const doc = seed({})
    await updateDocMetadata({ docId: doc.id, metadata: { status: "draft" } })
    expect(store.changes.map((c) => [c.kind, c.docId])).toEqual([["UPSERT", doc.id]])
  })

  it("does not log CANVAS docs", async () => {
    const doc = seed({ docType: "CANVAS", content: JSON.stringify({ nodes: [], edges: [] }) })
    await updateDocMetadata({ docId: doc.id, metadata: { a: 1 } })
    expect(store.changes).toHaveLength(0)
  })

  it("rolls the legacy write back with the failed change row", async () => {
    const doc = seed({})
    store.failChangeWrite = true
    await expect(updateDoc({ docId: doc.id, content: "never" })).rejects.toThrow("change write failed")
    expect(store.docs[0].content).toBe("body")
  })
})

describe("legacy version restore", () => {
  it("logs a MOVE when the restored title differs and an UPSERT when it does not", async () => {
    const doc = seed({ title: "Current" })
    store.versions.push({ id: "v-1", docId: doc.id, title: "Old title", content: "old", metadata: null, icon: null, createdAt: new Date("2026-01-01") })
    store.versions.push({ id: "v-2", docId: doc.id, title: "Old title", content: "older", metadata: null, icon: null, createdAt: new Date("2026-01-01") })
    await restoreDocVersionCore("v-1", { authorName: "Tester" })
    await restoreDocVersionCore("v-2", { authorName: "Tester" })
    expect(store.changes.map((c) => [c.kind, c.path])).toEqual([["MOVE", "Old title"], ["UPSERT", "Old title"]])
  })
})

describe("link touch (updatedAt only)", () => {
  const tx = () => syncFake.fake as never

  it("needs no row for a doc with a stored revision: content, path and revision are unchanged", async () => {
    const doc = seed({ revision: "rev-0" })
    await touchEndpoint(tx(), "DOC", WS, doc.id)
    expect(store.changes).toHaveLength(0)
  })

  it("logs an UPSERT for a pre-revision doc, whose derived revision comes from updatedAt", async () => {
    const doc = seed({ revision: null })
    await touchEndpoint(tx(), "DOC", WS, doc.id)
    expect(store.changes.map((c) => [c.kind, c.docId])).toEqual([["UPSERT", doc.id]])
  })

  it("writes nothing when sync is off", async () => {
    vi.stubEnv("DOCS_SYNC_ENABLED", "")
    const doc = seed({ revision: null })
    await touchEndpoint(tx(), "DOC", WS, doc.id)
    expect(store.changes).toHaveLength(0)
    expect(store.counters).toHaveLength(0)
  })
})

describe("flag off", () => {
  it("legacy handlers and restore write no change rows or counters", async () => {
    vi.stubEnv("DOCS_SYNC_ENABLED", "")
    const doc = seed({})
    await createDoc({ workspaceId: WS, title: "Fresh", content: "hello" })
    await updateDoc({ docId: doc.id, title: "Renamed" })
    await updateDocMetadata({ docId: doc.id, metadata: { a: 1 } })
    store.versions.push({ id: "v-1", docId: doc.id, title: "Old", content: "old", metadata: null, icon: null, createdAt: new Date("2026-01-01") })
    await restoreDocVersionCore("v-1", { authorName: "Tester" })
    expect(store.changes).toHaveLength(0)
    expect(store.counters).toHaveLength(0)
    expect(store.docs.find((d) => d.id === doc.id)!.title).toBe("Old")
  })
})
