/**
 * A plain `kind: qa-report` frontmatter key sets Doc.kind QA_REPORT on CREATE only (the agent file-tree path: createPath, and
 * writePath's create branch). Whitelisted spellings only; never on update; never a docType; the key stays in metadata.
 * Same in-memory database harness as doc-fs-kind.test.ts.
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

import { createPath, writePath, readPath } from "@/lib/doc-fs"
import { DOC_TYPES } from "@/lib/doc-types"
import { kindFromFrontmatterClaim } from "@/lib/doc-kinds"
import { safeMatter } from "@/lib/safe-matter"

const WS = "ws-1"
const opts = { authorName: "Agent" }
const rowAt = (title: string) => (mem.docs as Row[]).find((r) => r.title === title)!
const fm = (kind: string) => `---\nkind: ${kind}\ntopic: x\n---\nbody`

beforeEach(() => {
  mem.docs = []
  mem.versions = []
  mem.receipts = []
})

describe("kindFromFrontmatterClaim", () => {
  it.each(["qa-report", "qa_report", "qa report", "QA_REPORT", "QA-Report", "  QA Report  ", "qa--report", "qa _report", "Qa\tReport"])("accepts %j", (v) => {
    expect(kindFromFrontmatterClaim(v)).toBe("QA_REPORT")
  })
  it.each(["canvas", "CANVAS", "spec", "SPEC", "gtm", "GTM_POSITIONING_BRIEF", "adr", "ADR", "design", "note", "qa", "qareport", "qa-reports", "", "   ", null, undefined, 7, true, {}, ["qa-report"]])("rejects %j", (v) => {
    expect(kindFromFrontmatterClaim(v)).toBeNull()
  })
})

describe("create from an agent file (createPath)", () => {
  it("derives kind QA_REPORT, keeps `kind` in metadata, leaves docType STANDARD", async () => {
    const res = await createPath(WS, "QA/Report one", fm("qa-report"), opts)
    expect(res.kind).toBe("QA_REPORT")
    const row = rowAt("Report one")
    expect(row.kind).toBe("QA_REPORT")
    expect(row.docType).toBe("STANDARD")
    expect(row.metadata).toEqual({ kind: "qa-report", topic: "x" })
    expect(row.content).toBe("body")
  })

  it.each(["canvas", "spec", "gtm", "adr", "whatever"])("a non-whitelisted claim %s sets nothing and never a docType", async (claim) => {
    await createPath(WS, `Doc ${claim}`, fm(claim), opts)
    const row = rowAt(`Doc ${claim}`)
    expect(row.kind ?? null).toBeNull()
    expect(row.docType).toBe("STANDARD")
    expect((row.metadata as Record<string, unknown>).kind).toBe(claim)
  })

  it("does not copy the kind onto implicit parents", async () => {
    await createPath(WS, "Parent/Child", fm("qa_report"), opts)
    expect(rowAt("Parent").kind ?? null).toBeNull()
    expect(rowAt("Child").kind).toBe("QA_REPORT")
  })

  it("an explicit kind option wins over the frontmatter claim", async () => {
    await createPath(WS, "Explicit", fm("qa-report"), { ...opts, kind: "NOTE" })
    expect(rowAt("Explicit").kind).toBe("NOTE")
  })

  it("compass_doc_type and compass_kind in frontmatter are still stripped and never set anything", async () => {
    await createPath(WS, "Spoof", "---\ncompass_doc_type: CANVAS\ncompass_kind: ADR\nkind: qa-report\n---\nbody", opts)
    const row = rowAt("Spoof")
    expect(row.docType).toBe("STANDARD")
    expect(row.kind).toBe("QA_REPORT")
    expect(row.metadata).toEqual({ kind: "qa-report" })
    const read = safeMatter((await readPath(WS, "Spoof"))!.content).data
    expect(read.compass_doc_type).toBe("STANDARD")
    expect(read.compass_kind).toBe("QA_REPORT")
  })
})

describe("update never retypes", () => {
  it("writePath create derives the kind; a later update with another claim leaves it", async () => {
    await writePath(WS, "Wp", fm("qa-report"), opts)
    expect(rowAt("Wp").kind).toBe("QA_REPORT")
    await writePath(WS, "Wp", "---\nkind: design\n---\nnew", opts)
    expect(rowAt("Wp").kind).toBe("QA_REPORT")
    expect(rowAt("Wp").docType).toBe("STANDARD")
  })

  it("updating an untyped doc with kind: qa-report does not set the kind", async () => {
    await writePath(WS, "Plain", "body", opts)
    await writePath(WS, "Plain", fm("qa-report"), opts)
    expect(rowAt("Plain").kind ?? null).toBeNull()
    expect((rowAt("Plain").metadata as Record<string, unknown>).kind).toBe("qa-report")
  })
})

describe("DOC_TYPES is unchanged (QA report is a Doc.kind, not a docType)", () => {
  it("lists exactly the four stored types", () => {
    expect([...DOC_TYPES]).toEqual(["STANDARD", "GTM_POSITIONING_BRIEF", "CANVAS", "SPEC"])
  })
})
