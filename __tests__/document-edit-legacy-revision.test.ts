import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * An agent edit (editDocumentBody -> updateDocument) on a legacy doc: revision column NULL, updated_at stamped by the database at
 * microsecond precision. The row's token is `legacy:<ms ISO>`; the compare-and-swap must still match, or every attempt conflicts
 * ("Doc kept changing underneath this edit") although nothing else wrote the doc.
 */
const stored = vi.hoisted(() => ({ updatedAtMicros: 0, revision: null as string | null, content: "old text" }))
const mocks = vi.hoisted(() => {
  type Where = { revision: string | null; updatedAt?: Date | { gte: Date; lt: Date } }
  const matches = (where: Where) => {
    if (where.revision !== stored.revision) return false
    const at = where.updatedAt
    if (!at) return true
    // Postgres compares the Date (ms) against the stored microseconds.
    if (at instanceof Date) return at.getTime() * 1000 === stored.updatedAtMicros
    return at.gte.getTime() * 1000 <= stored.updatedAtMicros && stored.updatedAtMicros < at.lt.getTime() * 1000
  }
  const row = () => ({
    id: "doc-a", workspaceId: "workspace-a", title: "PRD", docType: "STANDARD", storageProvider: null, contentRef: null, metadata: null, icon: null,
    content: stored.content, revision: stored.revision, createdAt: new Date(0),
    // JS only ever sees milliseconds.
    updatedAt: new Date(Math.floor(stored.updatedAtMicros / 1000)),
  })
  const doc = {
    findUnique: vi.fn(async () => row()),
    updateMany: vi.fn(async ({ where, data }: { where: Where; data: { revision: string; content: string } }) => {
      if (!matches(where)) return { count: 0 }
      stored.revision = data.revision
      stored.content = data.content
      return { count: 1 }
    }),
  }
  const db = { doc, docVersion: { findFirst: vi.fn(async () => null), create: vi.fn() }, docOperation: { findUnique: vi.fn(async () => null), create: vi.fn() }, $transaction: vi.fn() }
  db.$transaction.mockImplementation(async (fn: (tx: typeof db) => unknown) => fn(db))
  return { db }
})
vi.mock("@/lib/db", () => ({ default: () => mocks.db }))
vi.mock("@/lib/work-item-sequence", async () => (await import("./helpers/work-item-sequence-mock")).workItemSequenceMock())
vi.mock("@/lib/document-storage", () => ({ isDocumentPilotWorkspace: () => false, getDocumentStore: () => ({}) }))
vi.mock("@/lib/doc-versions", () => ({ maybeSnapshotDocVersion: vi.fn() }))
vi.mock("@/lib/document-mcp-actor", () => ({ documentMcpActor: () => ({ authorName: "Agent", actorKey: "agent:1" }) }))

describe("editDocumentBody on a legacy (null revision) doc", () => {
  beforeEach(() => {
    stored.updatedAtMicros = Date.UTC(2026, 9, 9, 12, 0, 0, 123) * 1000 + 456 // 2026-10-09T12:00:00.123456Z
    stored.revision = null
    stored.content = "old text"
    mocks.db.doc.updateMany.mockClear()
  })

  it("succeeds on the first attempt even though updated_at has sub-millisecond digits", async () => {
    const { editDocumentBody } = await import("@/lib/document-edit")
    const outcome = await editDocumentBody("doc-a", (doc) => ({ ok: true, content: doc.content.replace("old", "new"), result: null }))
    expect(outcome).toMatchObject({ ok: true, changed: true, attempts: 1 })
    expect(stored.content).toBe("new text")
    expect(stored.revision).toEqual(expect.any(String)) // promoted: later edits use the real revision
  })

  it("reads the same legacy revision every time (no fresh token per read)", async () => {
    const { documentRevision } = await import("@/lib/document-service")
    const first = documentRevision((await mocks.db.doc.findUnique()) as never)
    const second = documentRevision((await mocks.db.doc.findUnique()) as never)
    expect(first).toBe("legacy:2026-10-09T12:00:00.123Z")
    expect(second).toBe(first)
  })
})
