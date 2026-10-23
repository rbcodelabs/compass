/**
 * createSpecCore / listSpecDocs against the where-honouring tenant fake: the scope is verified in the caller's workspace, creation always
 * makes a NEW doc, a failed link write deletes the doc again, and the DOC_SPECIFIES_SCOPE link is tenant-safe.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { WS_A, WS_B, createTenantFakePrisma } from "../helpers/tenant-fake-prisma"

const fake = vi.hoisted(() => ({ current: null as null | ReturnType<typeof createTenantFakePrisma> }))
const docService = vi.hoisted(() => ({ created: 0, deleteFails: false }))

vi.mock("@/lib/db", () => ({ default: () => fake.current!.client }))
vi.mock("@/lib/workspace-updates-capture", () => ({
  withWorkspaceUpdates: async (prisma: unknown, _workspaceId: unknown, callback: (tx: unknown, capture: boolean) => unknown) => callback(prisma, false),
  withAtomicRetry: async (prisma: unknown, callback: (tx: unknown) => unknown) => callback(prisma),
  withUpdatesTables: async (prisma: unknown, callback: (tx: unknown, tablesExist: boolean) => unknown) => callback(prisma, false),
}))
vi.mock("@/lib/document-service", () => ({
  documentRevision: (doc: { revision: string | null }) => doc.revision ?? "legacy",
  createDocument: vi.fn(async (input: Record<string, unknown>) => {
    const row = { id: `doc-new-${++docService.created}`, revision: `rev-${docService.created}`, createdAt: new Date(2_000 + docService.created), updatedAt: new Date(2_000 + docService.created), ...input }
    fake.current!.state.docs.push(row)
    return row
  }),
  deleteDocument: vi.fn(async (docId: string) => {
    if (docService.deleteFails) throw new Error("delete failed")
    const docs = fake.current!.state.docs
    docs.splice(docs.findIndex((d) => d.id === docId), 1)
  }),
}))

import { createSpecCore, listSpecDocs, scopeNotFoundMessage } from "@/lib/spec-docs/create"
import { createDocument, deleteDocument } from "@/lib/document-service"
import { linkEntities } from "@/lib/links/service"
import { TypedLinkError } from "@/lib/typed-links"
import type { AppTransactionClient } from "@/lib/db"

const actor = { userId: "user-alice", authorName: "Alice", source: "MCP" as const }
const state = () => fake.current!.state
const linksOf = () => state().entityLinks.filter((l) => l.linkType === "DOC_SPECIFIES_SCOPE")
const docs = () => state().docs.filter((d) => d.docType === "SPEC")
const create = (overrides: Partial<Parameters<typeof createSpecCore>[0]> = {}) =>
  createSpecCore({ workspaceId: WS_A.id, scopeType: "SOLUTION", scopeId: "sol-a", ...overrides }, actor)

beforeEach(() => {
  fake.current = createTenantFakePrisma()
  docService.created = 0
  docService.deleteFails = false
  vi.mocked(createDocument).mockClear()
  vi.mocked(deleteDocument).mockClear()
})
afterEach(() => vi.restoreAllMocks())

describe("createSpecCore", () => {
  it("creates a SPEC doc for a solution, links it to the solution in the caller's workspace and records the template", async () => {
    const result = await create({ label: "v2" })
    expect(result).toMatchObject({ ok: true, scopeType: "SOLUTION", scopeId: "sol-a", template: "spec@1", label: "v2", title: "Spec - A solution (v2)" })
    expect(docs()).toHaveLength(1)
    expect(docs()[0]).toMatchObject({ workspaceId: WS_A.id, docType: "SPEC", parentId: null, metadata: { template: "spec@1", label: "v2" }, source: "MCP", createdById: "user-alice" })
    expect(String(docs()[0].content)).toContain("compass://solution/sol-a")
    expect(linksOf()).toHaveLength(1)
    expect(linksOf()[0]).toMatchObject({ workspaceId: WS_A.id, fromType: "DOC", fromId: "doc-new-1", toType: "SOLUTION", toId: "sol-a", origin: "DIRECT", source: "MCP", createdById: "user-alice" })
  })

  it("creates a Discovery Plan for an opportunity", async () => {
    const result = await create({ scopeType: "OPPORTUNITY", scopeId: "opp-a" })
    expect(result).toMatchObject({ ok: true, template: "discovery-plan@1", title: "Discovery Plan - A opportunity" })
    expect(linksOf()[0]).toMatchObject({ fromType: "DOC", toType: "OPPORTUNITY", toId: "opp-a" })
  })

  it("is NOT idempotent: two creates for one scope make two docs, both linked and both listed", async () => {
    const first = await create()
    const second = await create()
    expect(first.ok && second.ok).toBe(true)
    expect(first.ok && second.ok && first.docId !== second.docId).toBe(true)
    expect(docs()).toHaveLength(2)
    expect(linksOf()).toHaveLength(2)
    const listed = await listSpecDocs({ workspaceId: WS_A.id, scopeType: "SOLUTION", scopeId: "sol-a" })
    expect(listed?.map((d) => d.id)).toEqual(["doc-new-1", "doc-new-2"])
  })

  it.each([
    ["a solution in another workspace", { scopeId: "sol-b" }],
    ["a solution that does not exist", { scopeId: "11111111-1111-4111-8111-111111111111" }],
    ["a solution whose workspace is NULL", { scopeId: "sol-null" }],
    ["an opportunity in another workspace", { scopeType: "OPPORTUNITY" as const, scopeId: "opp-b" }],
  ])("%s is scope_not_found, creates nothing, and is indistinguishable from a missing one", async (_label, overrides) => {
    expect(await create(overrides)).toEqual({ ok: false, error: "scope_not_found" })
    expect(createDocument).not.toHaveBeenCalled()
    expect(docs()).toEqual([])
    expect(linksOf()).toEqual([])
    expect(scopeNotFoundMessage("SOLUTION")).toBe("Solution not found in this workspace.")
  })

  it("deletes the doc again (compensating step) when the link write fails, and rethrows the failure", async () => {
    vi.spyOn(fake.current!.client.entityLink, "create").mockRejectedValue(new Error("boom"))
    await expect(create()).rejects.toThrow("boom")
    expect(deleteDocument).toHaveBeenCalledWith("doc-new-1", expect.objectContaining({ workspaceId: WS_A.id, expectedRevision: "rev-1" }))
    expect(docs()).toEqual([])
    expect(linksOf()).toEqual([])
  })

  it("reports scope_not_found and deletes the doc when the scope vanishes between verification and linking", async () => {
    vi.spyOn(fake.current!.client.solution, "findMany").mockResolvedValue([])
    expect(await create()).toEqual({ ok: false, error: "scope_not_found" })
    expect(deleteDocument).toHaveBeenCalledTimes(1)
    expect(docs()).toEqual([])
  })

  it("still surfaces the original failure when the compensating delete itself fails", async () => {
    vi.spyOn(fake.current!.client.entityLink, "create").mockRejectedValue(new Error("boom"))
    const log = vi.spyOn(console, "error").mockImplementation(() => {})
    docService.deleteFails = true
    await expect(create()).rejects.toThrow("boom")
    expect(log).toHaveBeenCalledWith(expect.stringContaining("compensating delete"), expect.objectContaining({ docId: "doc-new-1" }))
  })

  it("generates the sections from the scope's real records, in the caller's workspace only", async () => {
    const s = state()
    s.solutionKeyResultLinks.push({ id: "skr-1", workspaceId: WS_A.id, solutionId: "sol-a", keyResultId: "kr-a", createdAt: new Date(1) })
    s.assumptions.push({ id: "asm-a2", solutionId: "sol-a", title: "Second", sortOrder: 5, createdAt: new Date(5) })
    Object.assign(s.assumptions[0], { sortOrder: 1, createdAt: new Date(1) })
    s.experiments.push({ id: "exp-on-asm", workspaceId: WS_A.id, title: "Tests asm", status: "DESIGNING", assumptionId: "asm-a", createdAt: new Date(1), updatedAt: new Date(1) })
    s.experiments.push({ id: "exp-foreign", workspaceId: WS_B.id, title: "Foreign", status: "DESIGNING", assumptionId: "asm-a", createdAt: new Date(1), updatedAt: new Date(1) })
    s.artifactLinks.push({ id: "al-1", workspaceId: WS_A.id, artifactId: "art-a", linkedType: "SOLUTION", linkedId: "sol-a" })
    s.artifactLinks.push({ id: "al-2", workspaceId: WS_A.id, artifactId: "art-a-archived", linkedType: "SOLUTION", linkedId: "sol-a" })
    s.artifactLinks.push({ id: "al-3", workspaceId: WS_B.id, artifactId: "art-b", linkedType: "SOLUTION", linkedId: "sol-a" })
    expect((await create()).ok).toBe(true)
    const body = String(docs()[0].content)
    const order = ["keyResult/kr-a", "solution/sol-a", "assumption/asm-a)", "assumption/asm-a2", "experiment/exp-on-asm", "artifact/art-a)"].map((needle) => body.indexOf(`compass://${needle}`))
    expect(order.every((at) => at >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(body).not.toContain("exp-foreign")
    expect(body).not.toContain("art-a-archived")
    expect(body).not.toContain("art-b")
  })

  it("lists the riskiest open assumptions first for a Discovery Plan and leaves validated ones out", async () => {
    const s = state()
    const base = { solutionId: "sol-a", sortOrder: 0 }
    s.assumptions.push(
      { id: "a-low", ...base, title: "low", riskLevel: "LOW", status: "UNTESTED", createdAt: new Date(1) },
      { id: "a-high", ...base, title: "high", riskLevel: "HIGH", status: "TESTING", createdAt: new Date(2) },
      { id: "a-done", ...base, title: "done", riskLevel: "HIGH", status: "VALIDATED", createdAt: new Date(3) },
    )
    expect((await create({ scopeType: "OPPORTUNITY", scopeId: "opp-a" })).ok).toBe(true)
    const body = String(docs()[0].content)
    expect(body.indexOf("assumption/a-high")).toBeGreaterThan(-1)
    expect(body.indexOf("assumption/a-high")).toBeLessThan(body.indexOf("assumption/a-low"))
    expect(body).not.toContain("a-done")
    expect(body).toContain("compass://solution/sol-a")
  })
})

describe("DOC_SPECIFIES_SCOPE tenant safety", () => {
  const tx = () => fake.current!.client as unknown as AppTransactionClient
  const link = (fromId: string, toId: string, toType: string, expectedWorkspaceId: string) =>
    linkEntities(tx(), { linkType: "DOC_SPECIFIES_SCOPE", fromId, toId, toType, expectedWorkspaceId, ctx: { source: "MCP" } })

  it("links a doc and a scope of one workspace", async () => {
    expect((await link("doc-a", "sol-a", "SOLUTION", WS_A.id)).created).toBe(true)
    expect((await link("doc-a", "opp-a", "OPPORTUNITY", WS_A.id)).created).toBe(true)
  })

  it.each([
    ["a doc in another workspace", "doc-b", "sol-a", WS_A.id],
    ["a scope in another workspace", "doc-a", "sol-b", WS_A.id],
    ["a forged expected workspace", "doc-a", "sol-a", WS_B.id],
    ["a doc with a NULL workspace", "doc-null", "sol-a", WS_A.id],
    ["a solution with a NULL workspace", "doc-a", "sol-null", WS_A.id],
  ])("fails closed for %s and writes nothing", async (_label, fromId, toId, workspaceId) => {
    await expect(link(fromId, toId, "SOLUTION", workspaceId)).rejects.toBeInstanceOf(TypedLinkError)
    await expect(link(fromId, toId, "SOLUTION", workspaceId)).rejects.toThrow(/not found in this workspace/)
    expect(state().entityLinks).toEqual([])
  })

  it("refuses a target type the link type does not allow", async () => {
    await expect(link("doc-a", "exp-a", "EXPERIMENT", WS_A.id)).rejects.toThrow(/links to SOLUTION, OPPORTUNITY/)
  })

  it("many-to-many and idempotent for the same pair", async () => {
    await link("doc-a", "sol-a", "SOLUTION", WS_A.id)
    await link("doc-a", "sol-a", "SOLUTION", WS_A.id)
    await link("doc-a", "opp-a", "OPPORTUNITY", WS_A.id)
    expect(linksOf()).toHaveLength(2)
  })
})

describe("listSpecDocs", () => {
  it("returns null for a scope outside the workspace, identical for foreign and missing", async () => {
    expect(await listSpecDocs({ workspaceId: WS_A.id, scopeType: "SOLUTION", scopeId: "sol-b" })).toBeNull()
    expect(await listSpecDocs({ workspaceId: WS_A.id, scopeType: "SOLUTION", scopeId: "11111111-1111-4111-8111-111111111111" })).toBeNull()
  })

  it("returns only SPEC docs, with label and template from metadata, and drops a link whose doc is gone", async () => {
    await create({ label: "first" })
    const stranger = { id: "doc-plain", workspaceId: WS_A.id, title: "Plain", docType: "STANDARD", metadata: null, parentId: null, sortOrder: 0, createdAt: new Date(1), updatedAt: new Date(1) }
    state().docs.push(stranger)
    await linkEntities(fake.current!.client as unknown as AppTransactionClient, { linkType: "DOC_SPECIFIES_SCOPE", fromId: "doc-plain", toId: "sol-a", toType: "SOLUTION", expectedWorkspaceId: WS_A.id, ctx: { source: "MCP" } })
    await create({ label: "second" })
    state().docs.splice(state().docs.findIndex((d) => d.id === "doc-new-2"), 1) // an orphaned link: the doc is gone
    const listed = await listSpecDocs({ workspaceId: WS_A.id, scopeType: "SOLUTION", scopeId: "sol-a" })
    expect(listed?.map((d) => [d.id, d.label, d.template])).toEqual([["doc-new-1", "first", "spec@1"]])
  })
})
