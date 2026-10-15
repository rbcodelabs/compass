/**
 * doc-fs over the REAL document-service (its idempotency receipts, revision guards
 * and delete cascade), against an in-memory database. The bug this pins: an
 * implicit parent got a FIXED operation id, so re-creating a deleted parent path
 * replayed the receipt of the deleted doc and returned its dead id
 * ("Document parent-not-found" on the child).
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { randomUUID } from "node:crypto"

type Row = Record<string, unknown> & { id: string; workspaceId: string; parentId: string | null; title: string }
type Where = Record<string, unknown>

const mem = vi.hoisted(() => ({
  docs: [] as unknown[],
  versions: [] as unknown[],
  comments: [] as unknown[],
  receipts: [] as unknown[],
}))

vi.mock("@/lib/following-hooks", () => ({ followAfterCreate: vi.fn(), mcpFollowActor: vi.fn() }))
vi.mock("@/lib/document-storage", () => ({ isDocumentPilotWorkspace: () => false, getDocumentStore: vi.fn() }))
vi.mock("@/lib/db", () => {
  const matches = (row: Record<string, unknown>, where: Where = {}) =>
    Object.entries(where).every(([key, value]) => {
      if (value === undefined) return true
      if (key === "workspaceId_operationId") {
        const v = value as { workspaceId: string; operationId: string }
        return row.workspaceId === v.workspaceId && row.operationId === v.operationId
      }
      if (value instanceof Date) return (row[key] as Date)?.getTime() === value.getTime()
      return row[key] === value
    })
  const docs = () => mem.docs as Row[]
  const db = {
    doc: {
      findMany: async ({ where }: { where?: Where } = {}) => docs().filter((r) => matches(r, where)).map((r) => ({ ...r })),
      findUnique: async ({ where }: { where: Where }) => {
        const r = docs().find((x) => matches(x, where))
        return r ? { ...r } : null
      },
      findFirst: async ({ where }: { where?: Where } = {}) => {
        const r = docs().find((x) => matches(x, where))
        return r ? { ...r } : null
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: randomUUID(), createdAt: new Date(), updatedAt: new Date(), metadata: null, icon: null, roadmapItemId: null, docType: "STANDARD", storageProvider: "DATABASE", contentRef: null, sortOrder: 0, ...data } as Row
        docs().push(row)
        return { ...row }
      },
      update: async ({ where, data }: { where: Where; data: Record<string, unknown> }) => {
        const r = docs().find((x) => matches(x, where))!
        Object.assign(r, data)
        return { ...r }
      },
      updateMany: async ({ where, data }: { where: Where; data: Record<string, unknown> }) => {
        const found = docs().filter((x) => matches(x, where))
        found.forEach((r) => Object.assign(r, data))
        return { count: found.length }
      },
      delete: async ({ where }: { where: Where }) => {
        const index = docs().findIndex((x) => matches(x, where))
        const [removed] = docs().splice(index, 1)
        return removed
      },
    },
    docVersion: {
      findFirst: async () => null,
      findUnique: async () => null,
      create: async ({ data }: { data: unknown }) => { mem.versions.push(data); return data },
      deleteMany: async ({ where }: { where: Where }) => { mem.versions = mem.versions.filter((v) => !matches(v as Record<string, unknown>, where)); return { count: 0 } },
    },
    docComment: { deleteMany: async () => ({ count: 0 }) },
    docOperation: {
      findUnique: async ({ where }: { where: Where }) => (mem.receipts as Record<string, unknown>[]).find((r) => matches(r, where)) ?? null,
      create: async ({ data }: { data: unknown }) => { mem.receipts.push(data); return data },
    },
    $transaction: async (fn: (tx: unknown) => unknown) => fn(db),
  }
  return { default: () => db }
})

import { createPath, deletePath, listPaths, writePath } from "@/lib/doc-fs"

const WS = "ws-1"
const author = { authorName: "MCP Agent" }

beforeEach(() => {
  mem.docs = []
  mem.versions = []
  mem.comments = []
  mem.receipts = []
})

describe("re-creating a deleted implicit-parent path", () => {
  it("write_doc('Probe/Child') -> delete 'Probe' recursive -> write_doc('Probe/Child') again succeeds with NEW docs", async () => {
    const first = await writePath(WS, "Probe/Child", "one", author)
    expect(first.created).toBe(true)
    const firstParent = (await listPaths(WS)).find((n) => n.path === "Probe")!.docId

    await deletePath(WS, "Probe", { ...author, recursive: true })
    expect(await listPaths(WS)).toEqual([])

    const second = await writePath(WS, "Probe/Child", "two", author)
    expect(second.created).toBe(true)
    expect(second.docId).not.toBe(first.docId)
    const nodes = await listPaths(WS)
    expect(nodes.map((n) => n.path).sort()).toEqual(["Probe", "Probe/Child"])
    const parent = nodes.find((n) => n.path === "Probe")!
    expect(parent.docId).not.toBe(firstParent)
    // and the child really hangs off the NEW parent
    expect((mem.docs as Row[]).find((r) => r.id === second.docId)?.parentId).toBe(parent.docId)
  })

  it("works repeatedly (create, delete, create, delete, create)", async () => {
    for (let i = 0; i < 3; i++) {
      const written = await writePath(WS, "A/B/C", `v${i}`, author)
      expect(written.created).toBe(true)
      await deletePath(WS, "A", { ...author, recursive: true })
    }
    expect(await listPaths(WS)).toEqual([])
  })

  it("with a caller operationId, a retry after the parent was deleted creates a FRESH parent instead of replaying the dead one", async () => {
    const op = "00000000-0000-4000-8000-0000000000aa"
    await writePath(WS, "Probe/Child", "one", { ...author, operationId: op })
    const deadParent = (await listPaths(WS)).find((n) => n.path === "Probe")!.docId
    await deletePath(WS, "Probe", { ...author, recursive: true })
    // Same operation id, same path: the derived parent receipt still exists but its doc does not.
    // The leaf reuses the caller's id for a doc that no longer matches, which is the document layer's
    // own operation-conflict; what matters here is that the PARENT was not handed back as a dead id.
    await expect(createPath(WS, "Probe/Child", "one", { ...author, operationId: op })).rejects.toMatchObject({ code: "operation-conflict" })
    const parent = (await listPaths(WS)).find((n) => n.path === "Probe")
    expect(parent).toBeDefined()
    expect(parent!.docId).not.toBe(deadParent)
    expect((mem.docs as Row[]).some((r) => r.id === parent!.docId)).toBe(true)
  })

  it("still replays idempotently while the parent is alive: the same call twice makes one parent", async () => {
    const op = "00000000-0000-4000-8000-0000000000bb"
    await createPath(WS, "Solo/Leaf", "x", { ...author, operationId: op })
    await createPath(WS, "Solo/Leaf", "x", { ...author, operationId: op })
    expect((await listPaths(WS)).map((n) => n.path).sort()).toEqual(["Solo", "Solo/Leaf"])
    expect(mem.docs).toHaveLength(2)
  })
})

describe("the sandbox reconciler over the real document layer", () => {
  async function baselineOf() {
    const nodes = await listPaths(WS)
    return nodes.map((n) => {
      const row = (mem.docs as Row[]).find((r) => r.id === n.docId)!
      return { path: n.path, docId: n.docId, revision: row.revision as string, content: (row.content as string) ?? "" }
    })
  }

  it("deletes a parent and creates a doc at the same path in ONE pass, and replays the callback twice with no conflict", async () => {
    const { reconcileAgentDocs } = await import("@/lib/agent-doc-reconciliation")
    await writePath(WS, "Probe/Old", "old", author)
    const baseline = await baselineOf()
    const state = {
      files: [{ path: "Probe/New", content: "brand new", frontmatterDocId: null }],
      incomplete: false,
      deletedPaths: ["Probe/Old", "Probe"],
    }

    const first = await reconcileAgentDocs(WS, "run-1", baseline, state, "Compass Agent")
    expect(first.conflicts).toEqual([])
    expect((await listPaths(WS)).map((n) => n.path).sort()).toEqual(["Probe", "Probe/New"])
    const afterFirst = JSON.stringify((await listPaths(WS)).map((n) => [n.path, n.docId]))

    for (const attempt of [2, 3]) {
      const replay = await reconcileAgentDocs(WS, "run-1", baseline, state, "Compass Agent")
      expect(replay.conflicts, "attempt " + attempt).toEqual([])
      expect(replay.notices, "attempt " + attempt).toEqual([])
    }
    // nothing was created or deleted again
    expect(JSON.stringify((await listPaths(WS)).map((n) => [n.path, n.docId]))).toBe(afterFirst)
  })

  it("a later run (a different turn id) can create at a path an earlier run created and a human deleted", async () => {
    const { reconcileAgentDocs } = await import("@/lib/agent-doc-reconciliation")
    const state = { files: [{ path: "Fresh/Doc", content: "x", frontmatterDocId: null }], incomplete: false, deletedPaths: [] }
    await reconcileAgentDocs(WS, "run-A", [], state, "Compass Agent")
    await deletePath(WS, "Fresh", { ...author, recursive: true })
    const second = await reconcileAgentDocs(WS, "run-B", [], state, "Compass Agent")
    expect(second.conflicts).toEqual([])
    expect((await listPaths(WS)).map((n) => n.path).sort()).toEqual(["Fresh", "Fresh/Doc"])
  })
})
