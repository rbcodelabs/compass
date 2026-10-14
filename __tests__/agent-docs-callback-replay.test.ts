/**
 * A retried docs callback (a lost response, a worker retry) must not report
 * conflicts for work that already succeeded. This drives the REAL callback,
 * reconciler and doc-fs layers against an in-memory document store whose
 * create/update/delete honour operation receipts the way lib/document-service.ts
 * does (replay first, revision check second), and posts the same body three times.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { createHash } from "node:crypto"

type Row = {
  id: string
  workspaceId: string
  title: string
  parentId: string | null
  roadmapItemId: string | null
  docType: string
  content: string
  metadata: unknown
  revision: string
  sortOrder: number
  createdAt: Date
  updatedAt: Date
  storageProvider: string
}

const store = vi.hoisted(() => ({
  rows: [] as unknown[],
  receipts: new Map<string, unknown>(),
  counter: 0,
}))

vi.mock("@/lib/following-hooks", () => ({ followAfterCreate: vi.fn(), mcpFollowActor: vi.fn() }))
vi.mock("@/lib/db", () => {
  const rows = () => store.rows as Row[]
  const db = {
    doc: {
      findMany: async () => rows().map((r) => ({ ...r })),
      findUnique: async ({ where }: { where: { id: string } }) => {
        const r = rows().find((x) => x.id === where.id)
        return r ? { ...r } : null
      },
      findFirst: async ({ where }: { where: { workspaceId?: string; parentId?: string | null } }) => rows().find((x) => (where.parentId === undefined || x.parentId === where.parentId)) ?? null,
    },
    docVersion: { create: async () => ({}) },
    docOperation: {
      findUnique: async ({ where }: { where: { workspaceId_operationId: { workspaceId: string; operationId: string } } }) => {
        const key = `${where.workspaceId_operationId.workspaceId}:${where.workspaceId_operationId.operationId}`
        return store.receipts.has(key) ? { id: key } : null
      },
    },
  }
  return { default: () => db }
})
vi.mock("@/lib/document-service", async () => {
  const actual = await vi.importActual<typeof import("@/lib/document-service")>("@/lib/document-service")
  const rows = () => store.rows as Row[]
  const key = (ws: string, op: string) => `${ws}:${op}`
  return {
    ...actual,
    hydrateDocument: async (_ws: string, row: unknown) => row,
    createDocument: async (data: Partial<Row> & { workspaceId: string }, opts: { operationId?: string }) => {
      if (opts.operationId && store.receipts.has(key(data.workspaceId, opts.operationId))) return store.receipts.get(key(data.workspaceId, opts.operationId))
      const row: Row = {
        id: `created-${++store.counter}`, workspaceId: data.workspaceId, title: data.title ?? "Untitled", parentId: data.parentId ?? null,
        roadmapItemId: null, docType: data.docType ?? "STANDARD", content: data.content ?? "", metadata: data.metadata ?? null,
        revision: `rev-created-${store.counter}`, sortOrder: data.sortOrder ?? 0, createdAt: new Date(), updatedAt: new Date(), storageProvider: "DATABASE",
      }
      rows().push(row)
      if (opts.operationId) store.receipts.set(key(data.workspaceId, opts.operationId), { ...row })
      return { ...row }
    },
    updateDocument: async (docId: string, change: Partial<Row>, opts: { operationId?: string; expectedRevision?: string }) => {
      const row = rows().find((r) => r.id === docId)
      if (!row) throw new actual.DocumentError("not-found")
      const receipt = opts.operationId ? key(row.workspaceId, opts.operationId) : null
      if (receipt && store.receipts.has(receipt)) return store.receipts.get(receipt) // replay BEFORE the revision check
      if (opts.expectedRevision !== undefined && opts.expectedRevision !== row.revision) throw new actual.DocumentError("revision-conflict")
      Object.assign(row, change, { revision: `rev-${++store.counter}`, updatedAt: new Date() })
      if (receipt) store.receipts.set(receipt, { ...row })
      return { ...row }
    },
    deleteDocument: async (docId: string, opts: { expectedRevision?: string }) => {
      const index = rows().findIndex((r) => r.id === docId)
      if (index < 0) throw new actual.DocumentError("not-found")
      if (opts.expectedRevision !== undefined && opts.expectedRevision !== rows()[index].revision) throw new actual.DocumentError("revision-conflict")
      rows().splice(index, 1)
    },
  }
})

import { handleAgentDocsReconcile } from "@/lib/agent-docs-callback"
import { signDocManifest } from "@/lib/agent-doc-manifest"
import { agentRunSandboxName, hashAgentRunWorkerToken } from "@/lib/agent-runs"

const RUN_ID = "11111111-1111-4111-8111-111111111111"
const WS = "22222222-2222-4222-8222-222222222222"
const TOKEN = "t".repeat(43)
const sha = (t: string) => createHash("sha256").update(t).digest("hex")

function seed() {
  const mk = (id: string, title: string, parentId: string | null, content: string, revision: string): Row => ({
    id, workspaceId: WS, title, parentId, roadmapItemId: null, docType: "STANDARD", content, metadata: null, revision,
    sortOrder: 0, createdAt: new Date(1), updatedAt: new Date(1), storageProvider: "DATABASE",
  })
  store.rows = [mk("doc-1", "Product", null, "hello", "rev-1"), mk("doc-2", "Plan", "doc-1", "plan", "rev-2"), mk("doc-3", "Old", null, "old", "rev-3")]
  store.receipts = new Map()
  store.counter = 0
}

const baseline = [
  { path: "Product", docId: "doc-1", revision: "rev-1", content: "hello" },
  { path: "Product/Plan", docId: "doc-2", revision: "rev-2", content: "plan" },
  { path: "Old", docId: "doc-3", revision: "rev-3", content: "old" },
]

function request(body: unknown) {
  return new Request(`https://c.test/api/internal/agent/runs/${RUN_ID}/docs`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  })
}

const prisma = () =>
  ({
    agentRun: {
      findUnique: vi.fn().mockResolvedValue({
        id: RUN_ID, workspaceId: WS, userId: "user-1", status: "RUNNING", kind: "CHAT", claimId: null,
        workerTokenHash: hashAgentRunWorkerToken(TOKEN), deadlineAt: new Date(Date.now() + 600_000), sandboxName: agentRunSandboxName(RUN_ID),
        apiKeyId: null, packProvenance: "[]", lastSeq: 0, eventCount: 0, payloadBytes: 0, conversationId: "c", createdAt: new Date(),
      }),
    },
    workspace: { findFirst: vi.fn().mockResolvedValue({ id: WS }) },
  }) as never

beforeEach(() => {
  process.env.AUTH_SECRET = "test-auth-secret"
  seed()
})

describe("a repeated docs callback is idempotent", () => {
  const body = () => ({
    manifest: signDocManifest(RUN_ID, WS, baseline),
    incomplete: false,
    deletedPaths: ["Product/Plan", "Product/Plan", "Product/Plan"],
    files: [
      { path: "Product", frontmatterDocId: "doc-1", content: "edited by the agent" },
      { path: "Renamed", frontmatterDocId: "doc-3", contentSha256: sha("old") },
      { path: "Product/New Idea", frontmatterDocId: null, content: "brand new" },
    ],
  })

  it("applies the first pass, then replays it twice with no conflict notice and no duplicate docs", async () => {
    const first = await (await handleAgentDocsReconcile(request(body()), RUN_ID, prisma())).json()
    expect(first).toMatchObject({ conflicts: [], notice: null, applied: 4 })
    const afterFirst = JSON.parse(JSON.stringify(store.rows)) as Row[]
    expect(afterFirst.map((r) => r.title).sort()).toEqual(["New Idea", "Product", "Renamed"])
    expect(afterFirst.find((r) => r.id === "doc-1")?.content).toBe("edited by the agent")

    for (const attempt of [2, 3]) {
      const replay = await (await handleAgentDocsReconcile(request(body()), RUN_ID, prisma())).json()
      expect(replay.conflicts, `attempt ${attempt}`).toEqual([])
      expect(replay.notice, `attempt ${attempt}`).toBeNull()
    }
    // Nothing was created, renamed or deleted a second time.
    expect(store.rows.map((r) => (r as Row).title).sort()).toEqual(["New Idea", "Product", "Renamed"])
    expect((store.rows as Row[]).find((r) => r.id === "doc-1")?.content).toBe("edited by the agent")
  })

  it("a create is still a conflict when the path is held by someone else's doc (no receipt)", async () => {
    store.rows.push({
      id: "human-doc", workspaceId: WS, title: "New Idea", parentId: "doc-1", roadmapItemId: null, docType: "STANDARD",
      content: "a human wrote this", metadata: null, revision: "rev-h", sortOrder: 1, createdAt: new Date(1), updatedAt: new Date(1), storageProvider: "DATABASE",
    } satisfies Row)
    const result = await (await handleAgentDocsReconcile(request(body()), RUN_ID, prisma())).json()
    expect(result.conflicts).toEqual([expect.objectContaining({ title: "New Idea", reason: "exists" })])
    expect((store.rows as Row[]).find((r) => r.id === "human-doc")?.content).toBe("a human wrote this")
  })
})
