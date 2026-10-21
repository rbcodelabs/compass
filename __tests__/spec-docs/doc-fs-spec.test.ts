/**
 * SPEC docs through the docs filesystem and the agent edit tools: the docType survives buildTree, `compass_scopes` is derived and cannot
 * be spoofed, and agent writes (write_doc / edit_doc) are strict about compass:// embeds while the default doc-fs write path stays lenient.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { WS_A, WS_B, createTenantFakePrisma } from "../helpers/tenant-fake-prisma"

const fake = vi.hoisted(() => ({ current: null as null | ReturnType<typeof createTenantFakePrisma> }))
const svc = vi.hoisted(() => ({
  createDocument: vi.fn(),
  updateDocument: vi.fn(),
  deleteDocument: vi.fn(),
  hydrateDocument: vi.fn(),
  editDocumentBody: vi.fn(),
}))

vi.mock("@/lib/db", () => ({ default: () => fake.current!.client }))
vi.mock("@/lib/document-service", async () => {
  const actual = await vi.importActual<typeof import("@/lib/document-service")>("@/lib/document-service")
  return { ...actual, createDocument: svc.createDocument, updateDocument: svc.updateDocument, deleteDocument: svc.deleteDocument, hydrateDocument: svc.hydrateDocument }
})
vi.mock("@/lib/document-edit", () => ({ editDocumentBody: svc.editDocumentBody }))

import { DocFsError, listPaths, readPath, writeDocById, writePath } from "@/lib/doc-fs"
import { editDoc } from "@/lib/doc-edit-tool-handlers"
import { linkEntities } from "@/lib/links/service"
import type { AppTransactionClient } from "@/lib/db"

const SOL_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const SOL_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const OPP_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
const MISSING = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
const link = (id: string, title: string) => `[${title}](compass://solution/${id})`

const actor = { authorName: "Agent" }
const doc = (overrides: Record<string, unknown>) => ({
  workspaceId: WS_A.id, title: "Doc", docType: "STANDARD", metadata: null, parentId: null, sortOrder: 0, createdAt: new Date(1), updatedAt: new Date(1), revision: "r1", roadmapItemId: null, ...overrides,
})

beforeEach(() => {
  fake.current = createTenantFakePrisma()
  vi.clearAllMocks()
  const s = fake.current.state
  s.solutions.push(
    { id: SOL_A, workspaceId: WS_A.id, opportunityId: "opp-a", title: "Sol A", status: "IDEA", sortOrder: 0, createdAt: new Date(1), updatedAt: new Date(1) },
    { id: SOL_B, workspaceId: WS_B.id, opportunityId: "opp-b", title: "Sol B", status: "IDEA", sortOrder: 0, createdAt: new Date(1), updatedAt: new Date(1) },
  )
  s.opportunities.push({ id: OPP_A, workspaceId: WS_A.id, title: "Opp A", status: "EXPLORING", squadId: null, linkedKeyResultId: null, sortOrder: 0, createdAt: new Date(1) })
  svc.hydrateDocument.mockImplementation(async (_ws: string, d: { content: string | null }) => ({ content: d.content ?? "" }))
  svc.updateDocument.mockImplementation(async (id: string) => ({ id, revision: "r2", updatedAt: new Date(2) }))
})

const addDoc = (row: Record<string, unknown>) => fake.current!.state.docs.push(doc(row))
const scope = (docId: string, toId: string, toType: string) =>
  linkEntities(fake.current!.client as unknown as AppTransactionClient, { linkType: "DOC_SPECIFIES_SCOPE", fromId: docId, toId, toType, expectedWorkspaceId: WS_A.id, ctx: { source: "MCP" } })

describe("docType survives the docs filesystem", () => {
  it.each(["SPEC", "CANVAS", "GTM_POSITIONING_BRIEF"])("keeps %s", async (docType) => {
    addDoc({ id: "typed", title: "Typed", docType })
    const node = (await listPaths(WS_A.id)).find((n) => n.docId === "typed")
    expect(node?.docType).toBe(docType)
  })
  it("still reads an unknown stored type as STANDARD", async () => {
    addDoc({ id: "odd", title: "Odd", docType: "SOMETHING_ELSE" })
    expect((await listPaths(WS_A.id)).find((n) => n.docId === "odd")?.docType).toBe("STANDARD")
  })
})

describe("compass_scopes on the docs:// read", () => {
  it("lists the doc's scopes as solution:/opportunity: values, derived from the links", async () => {
    addDoc({ id: "spec-1", title: "Spec", docType: "SPEC", content: "# body" })
    await scope("spec-1", SOL_A, "SOLUTION")
    await scope("spec-1", OPP_A, "OPPORTUNITY")
    const read = await readPath(WS_A.id, "Spec")
    expect(read?.content).toContain("compass_doc_type: SPEC")
    expect(read?.content).toContain(`solution:${SOL_A}`)
    expect(read?.content).toContain(`opportunity:${OPP_A}`)
  })

  it("an unscoped SPEC doc reads an empty list", async () => {
    addDoc({ id: "spec-2", title: "Lonely", docType: "SPEC", content: "x" })
    expect((await readPath(WS_A.id, "Lonely"))?.content).toMatch(/compass_scopes: \[\]/)
  })

  it("cannot be spoofed through stored metadata, and never appears on a non-SPEC doc", async () => {
    addDoc({ id: "spec-3", title: "Spoofed", docType: "SPEC", content: "x", metadata: { compass_scopes: ["solution:evil"], keep: "me" } })
    addDoc({ id: "std-1", title: "Plain", docType: "STANDARD", content: "x", metadata: { compass_scopes: ["solution:evil"] } })
    const spoofed = (await readPath(WS_A.id, "Spoofed"))!.content
    expect(spoofed).not.toContain("evil")
    expect(spoofed).toContain("keep: me")
    expect((await readPath(WS_A.id, "Plain"))!.content).not.toContain("compass_scopes")
  })

  it("a link to a scope in another workspace is never shown", async () => {
    addDoc({ id: "spec-4", title: "Drift", docType: "SPEC", content: "x" })
    fake.current!.state.entityLinks.push({
      id: "drifted", workspaceId: WS_A.id, linkType: "DOC_SPECIFIES_SCOPE", fromType: "DOC", fromId: "spec-4", toType: "SOLUTION", toId: SOL_B,
      origin: "DIRECT", source: "MCP", createdById: null, attrs: null, createdAt: new Date(5), updatedAt: new Date(5),
    })
    expect((await readPath(WS_A.id, "Drift"))!.content).not.toContain(SOL_B)
  })

  it("a write cannot set compass_scopes: the reserved key is stripped before storage", async () => {
    addDoc({ id: "spec-5", title: "Target", docType: "SPEC", content: "old" })
    await writePath(WS_A.id, "Target", `---\ncompass_scopes:\n  - solution:${SOL_B}\nnote: kept\n---\nbody`, { ...actor })
    const change = svc.updateDocument.mock.calls[0][1] as { metadata?: Record<string, unknown> }
    expect(change.metadata).toEqual({ note: "kept" })
  })
})

describe("strict vs lenient embed validation", () => {
  const bad = ["[x](compass://)", `[x](compass://widget/${SOL_A})`, "[x](compass://solution/not-a-uuid)", "[x](compass://solution/"]
  beforeEach(() => addDoc({ id: "spec-w", title: "Spec", docType: "SPEC", content: "old" }))

  it.each(bad)("strict write_doc rejects %s and stores nothing", async (embed) => {
    await expect(writePath(WS_A.id, "Spec", `# t\n\n${embed}\n`, { ...actor, strictEmbeds: true })).rejects.toMatchObject({ name: "DocFsError", code: "invalid-embeds" })
    expect(svc.updateDocument).not.toHaveBeenCalled()
  })

  it.each(bad)("the default (UI / Geode sync) path keeps %s exactly as written", async (embed) => {
    const body = `# t\n\n${embed}\n`
    await writePath(WS_A.id, "Spec", body, { ...actor })
    expect(svc.updateDocument).toHaveBeenCalledWith("spec-w", expect.objectContaining({ content: body }), expect.anything())
  })

  it("strict accepts embeds that resolve in the doc's workspace", async () => {
    await writePath(WS_A.id, "Spec", `${link(SOL_A, "Sol A")}\n`, { ...actor, strictEmbeds: true })
    expect(svc.updateDocument).toHaveBeenCalledTimes(1)
  })

  it("a foreign-workspace id and a missing id produce the same error, which never confirms a foreign row", async () => {
    const attempt = async (id: string) => writePath(WS_A.id, "Spec", `${link(id, "x")}\n`, { ...actor, strictEmbeds: true }).catch((e: DocFsError) => e.message)
    const foreign = await attempt(SOL_B)
    const missing = await attempt(MISSING)
    expect(foreign).toBe(missing.replace(MISSING, SOL_B))
    expect(foreign).toMatch(/not found in this workspace/)
    expect(foreign).not.toMatch(/other workspace|another workspace|exists/i)
  })

  it("only SPEC docs are validated: a STANDARD doc keeps any link", async () => {
    addDoc({ id: "std-w", title: "Std", docType: "STANDARD", content: "old" })
    await writePath(WS_A.id, "Std", "[x](compass://)\n", { ...actor, strictEmbeds: true })
    expect(svc.updateDocument).toHaveBeenCalledTimes(1)
  })

  it("writeDocById (the sandbox reconciler) is strict only when asked", async () => {
    await writeDocById(WS_A.id, "spec-w", "[x](compass://)\n", { ...actor })
    expect(svc.updateDocument).toHaveBeenCalledTimes(1)
    await expect(writeDocById(WS_A.id, "spec-w", "[x](compass://)\n", { ...actor, strictEmbeds: true })).rejects.toBeInstanceOf(DocFsError)
  })
})

describe("edit_doc on a SPEC doc", () => {
  const run = async (docType: string, content: string, oldString: string, newString: string) => {
    svc.editDocumentBody.mockImplementation(async (_id: string, transform: (d: unknown) => Promise<{ ok: boolean; content?: string; error?: string; result?: unknown }>) => {
      const out = await transform({ id: "d", workspaceId: WS_A.id, title: "T", docType, content, revision: "r1" })
      return out.ok ? { ok: true, doc: { id: "d", revision: "r2", updatedAt: new Date(2) }, result: out.result, attempts: 1, changed: true } : { ok: false, code: "rejected", error: out.error }
    })
    return editDoc({ docId: "d", oldString, newString })
  }

  it("rejects an edit that leaves a malformed link", async () => {
    const result = await run("SPEC", "hello world", "world", "[x](compass://nope")
    expect(result.structuredContent.ok).toBe(false)
    expect(result.content[0].text).toMatch(/invalid compass:\/\/ links/)
  })

  it("rejects an edit that points at a record outside the doc's workspace without confirming it exists", async () => {
    const result = await run("SPEC", "hello world", "world", link(SOL_B, "x"))
    expect(result.structuredContent.ok).toBe(false)
    expect(result.content[0].text).toMatch(/not found in this workspace/)
    expect(result.content[0].text).not.toMatch(/other workspace|another workspace/i)
  })

  it("accepts an edit whose embeds resolve", async () => {
    const result = await run("SPEC", "hello world", "world", link(SOL_A, "Sol A"))
    expect(result.structuredContent.ok).toBe(true)
  })

  it("does not validate a STANDARD doc", async () => {
    const result = await run("STANDARD", "hello world", "world", "[x](compass://nope")
    expect(result.structuredContent.ok).toBe(true)
  })
})
