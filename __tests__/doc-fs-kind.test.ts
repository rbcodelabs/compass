/**
 * write_doc `kind` over the REAL doc-fs and document-service layers, against an in-memory database (the same harness as
 * doc-fs-real-layer.test.ts). Covers: persisted on create and update, an omitted kind never rejects and never changes an existing
 * one, null clears it, a kind-only change with identical content still lands, and the docs:// frontmatter.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { randomUUID } from "node:crypto"

type Row = Record<string, unknown> & { id: string; workspaceId: string; parentId: string | null; title: string }
type Where = Record<string, unknown>

const mem = vi.hoisted(() => ({ docs: [] as unknown[], versions: [] as unknown[], receipts: [] as unknown[] }))

vi.mock("@/lib/following-hooks", () => ({ followAfterCreate: vi.fn(), mcpFollowActor: vi.fn() }))
vi.mock("@/lib/document-storage", () => ({ isDocumentPilotWorkspace: () => false, getDocumentStore: vi.fn() }))
vi.mock("@/lib/document-mcp-actor", () => ({ documentMcpActor: () => ({ authorId: null, authorName: "MCP Agent" }) }))
vi.mock("@/lib/work-item-sequence", async () => (await import("./helpers/work-item-sequence-mock")).workItemSequenceMock())
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
    workspace: { findUnique: async () => ({ id: "ws-1", slug: "alpha", organization: { slug: "acme" } }) },
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
        const row = { id: randomUUID(), createdAt: new Date(), updatedAt: new Date(), metadata: null, icon: null, roadmapItemId: null, docType: "STANDARD", storageProvider: "DATABASE", contentRef: null, sortOrder: 0, kind: null, ...data } as unknown as Row
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
    },
    docVersion: {
      findFirst: async () => null,
      create: async ({ data }: { data: unknown }) => { mem.versions.push(data); return data },
    },
    docOperation: {
      findUnique: async ({ where }: { where: Where }) => (mem.receipts as Record<string, unknown>[]).find((r) => matches(r, where)) ?? null,
      create: async ({ data }: { data: unknown }) => { mem.receipts.push(data); return data },
    },
    $transaction: async (fn: (tx: unknown) => unknown) => fn(db),
  }
  return { default: () => db }
})

import { listPaths, readPath } from "@/lib/doc-fs"
import { writeDoc } from "@/lib/doc-fs-tool-handlers"
import { safeMatter } from "@/lib/safe-matter"

const WS = "ws-1"
const rowAt = (path: string) => (mem.docs as Row[]).find((r) => r.title === path)!
const data = (result: Awaited<ReturnType<typeof writeDoc>>) => result.structuredContent.data as Record<string, unknown>

beforeEach(() => {
  mem.docs = []
  mem.versions = []
  mem.receipts = []
})

describe("write_doc kind on create", () => {
  it("persists the kind and echoes it in the result", async () => {
    const result = await writeDoc({ workspaceId: WS, path: "Decisions/ADR - One", content: "body", kind: "ADR" })
    expect(result.structuredContent.ok).toBe(true)
    expect(rowAt("ADR - One").kind).toBe("ADR")
    expect(data(result).kind).toBe("ADR")
  })

  it("leaves the kind unset and succeeds when kind is omitted (a missing kind is never an error)", async () => {
    const result = await writeDoc({ workspaceId: WS, path: "Loose note", content: "body" })
    expect(result.structuredContent.ok).toBe(true)
    expect(rowAt("Loose note").kind ?? null).toBeNull()
    expect(data(result).kind ?? null).toBeNull()
  })

  it("does not copy the kind onto implicit parent docs", async () => {
    await writeDoc({ workspaceId: WS, path: "Parent/Child", content: "body", kind: "DESIGN" })
    expect(rowAt("Parent").kind ?? null).toBeNull()
    expect(rowAt("Child").kind).toBe("DESIGN")
  })

  it("accepts a null kind on create as unset", async () => {
    const result = await writeDoc({ workspaceId: WS, path: "Nullish", content: "body", kind: null })
    expect(result.structuredContent.ok).toBe(true)
    expect(rowAt("Nullish").kind ?? null).toBeNull()
  })
})

describe("write_doc kind on update", () => {
  it("keeps the existing kind when kind is omitted", async () => {
    await writeDoc({ workspaceId: WS, path: "Keep", content: "one", kind: "QA_REPORT" })
    const result = await writeDoc({ workspaceId: WS, path: "Keep", content: "two" })
    expect(result.structuredContent.ok).toBe(true)
    expect(rowAt("Keep").content).toBe("two")
    expect(rowAt("Keep").kind).toBe("QA_REPORT")
  })

  it("changes the kind when a different one is given", async () => {
    await writeDoc({ workspaceId: WS, path: "Change", content: "one", kind: "NOTE" })
    await writeDoc({ workspaceId: WS, path: "Change", content: "one", kind: "DESIGN" })
    expect(rowAt("Change").kind).toBe("DESIGN")
  })

  it("clears the kind with an explicit null", async () => {
    await writeDoc({ workspaceId: WS, path: "Clear", content: "one", kind: "ADR" })
    await writeDoc({ workspaceId: WS, path: "Clear", content: "two", kind: null })
    expect(rowAt("Clear").kind ?? null).toBeNull()
  })

  it("persists a kind-only change when the content is identical", async () => {
    await writeDoc({ workspaceId: WS, path: "Same", content: "identical" })
    const before = rowAt("Same").revision
    const result = await writeDoc({ workspaceId: WS, path: "Same", content: "identical", kind: "ADR" })
    expect(result.structuredContent.ok).toBe(true)
    expect(data(result).created).toBe(false)
    expect(rowAt("Same").kind).toBe("ADR")
    expect(rowAt("Same").revision).not.toBe(before)
  })

  it("keeps versioning: an overwrite still snapshots the doc", async () => {
    await writeDoc({ workspaceId: WS, path: "Versioned", content: "v1", kind: "NOTE" })
    await writeDoc({ workspaceId: WS, path: "Versioned", content: "v2", kind: "ADR" })
    expect(mem.versions.length).toBeGreaterThanOrEqual(1)
  })
})

describe("write_doc rejects an unknown kind value before writing", () => {
  it("refuses SPEC and PLAN and leaves nothing behind", async () => {
    for (const kind of ["SPEC", "PLAN", "adr"]) {
      const result = await writeDoc({ workspaceId: WS, path: `Bad ${kind}`, content: "body", kind })
      expect(result.structuredContent.ok, kind).toBe(false)
      expect(result.structuredContent.message).toMatch(/kind/i)
    }
    expect(mem.docs).toHaveLength(0)
  })
})

describe("docs:// frontmatter", () => {
  it("exposes compass_kind when the kind is set", async () => {
    await writeDoc({ workspaceId: WS, path: "Read me", content: "body", kind: "ADR" })
    const read = await readPath(WS, "Read me")
    expect(safeMatter(read!.content).data.compass_kind).toBe("ADR")
  })

  it("omits compass_kind when the kind is unset", async () => {
    await writeDoc({ workspaceId: WS, path: "Plain", content: "body" })
    const read = await readPath(WS, "Plain")
    expect(Object.keys(safeMatter(read!.content).data)).not.toContain("compass_kind")
  })

  it("treats a compass_kind in the written frontmatter as reserved: stripped, never sets the kind", async () => {
    await writeDoc({ workspaceId: WS, path: "Spoof", content: "---\ncompass_kind: ADR\ntopic: x\n---\nbody" })
    expect(rowAt("Spoof").kind ?? null).toBeNull()
    expect((rowAt("Spoof").metadata as Record<string, unknown>)).toEqual({ topic: "x" })
    const read = await readPath(WS, "Spoof")
    expect(Object.keys(safeMatter(read!.content).data)).not.toContain("compass_kind")
  })
})

describe("listPaths", () => {
  it("carries each doc's kind (null when unset)", async () => {
    await writeDoc({ workspaceId: WS, path: "A", content: "x", kind: "NOTE" })
    await writeDoc({ workspaceId: WS, path: "B", content: "x" })
    const nodes = await listPaths(WS)
    expect(nodes.find((n) => n.path === "A")?.kind).toBe("NOTE")
    expect(nodes.find((n) => n.path === "B")?.kind).toBeNull()
  })
})
