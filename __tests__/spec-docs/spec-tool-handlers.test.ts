/** create_spec / list_specs handler output: the `ID:` line, read/write symmetry, and identical not-found messages. */
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  createSpecCore: vi.fn(),
  listSpecDocs: vi.fn(),
  resolveById: vi.fn(),
  listPaths: vi.fn(),
}))

vi.mock("@/lib/db", () => ({
  default: () => ({ workspace: { findUnique: async () => ({ slug: "alpha", organization: { slug: "acme" } }) } }),
}))
vi.mock("@/lib/document-mcp-actor", () => ({ documentMcpActor: () => ({ authorId: "user-alice", authorName: "MCP Agent" }) }))
vi.mock("@/lib/doc-fs", () => ({ resolveById: mocks.resolveById, listPaths: mocks.listPaths }))
vi.mock("@/lib/spec-docs/create", async () => {
  const actual = await vi.importActual<typeof import("@/lib/spec-docs/create")>("@/lib/spec-docs/create")
  return { ...actual, createSpecCore: mocks.createSpecCore, listSpecDocs: mocks.listSpecDocs }
})

import { createSpec, listSpecs } from "@/lib/spec-tool-handlers"

const WS = "11111111-1111-4111-8111-111111111111"
const SCOPE = "22222222-2222-4222-8222-222222222222"
const DOC = "33333333-3333-4333-8333-333333333333"

beforeEach(() => vi.clearAllMocks())

describe("create_spec", () => {
  beforeEach(() => {
    mocks.createSpecCore.mockResolvedValue({ ok: true, docId: DOC, title: "Spec - Checkout", scopeType: "SOLUTION", scopeId: SCOPE, linkId: "link-1", template: "spec@1", label: null })
    mocks.resolveById.mockResolvedValue({ path: "Spec - Checkout" })
  })

  it("passes the MCP actor as the source and reports the doc id on its own `ID:` line", async () => {
    const result = await createSpec({ workspaceId: WS, scopeType: "SOLUTION", scopeId: SCOPE, label: "v2" })
    expect(mocks.createSpecCore).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: WS, scopeType: "SOLUTION", scopeId: SCOPE, label: "v2" }), { userId: "user-alice", authorName: "MCP Agent", source: "MCP" })
    const lines = result.content[0].text.split("\n")
    expect(lines).toContain(`ID: ${DOC}`)
    expect(lines.filter((l) => l.startsWith("ID: "))).toHaveLength(1)
    expect(result.structuredContent).toMatchObject({ ok: true, data: { id: DOC, path: "Spec - Checkout", docType: "SPEC", scopeType: "SOLUTION", scopeId: SCOPE, linkId: "link-1", template: "spec@1" } })
  })

  it("calls it a Discovery Plan for an opportunity", async () => {
    mocks.createSpecCore.mockResolvedValue({ ok: true, docId: DOC, title: "Discovery Plan - X", scopeType: "OPPORTUNITY", scopeId: SCOPE, linkId: "l", template: "discovery-plan@1", label: null })
    expect((await createSpec({ workspaceId: WS, scopeType: "OPPORTUNITY", scopeId: SCOPE })).content[0].text).toMatch(/^\*\*Discovery Plan created\*\*/)
  })

  it("a scope outside the workspace and a missing one return the same failure", async () => {
    mocks.createSpecCore.mockResolvedValue({ ok: false, error: "scope_not_found" })
    const result = await createSpec({ workspaceId: WS, scopeType: "SOLUTION", scopeId: SCOPE })
    expect(result.structuredContent).toMatchObject({ ok: false, message: "Solution not found in this workspace." })
  })

  it("a link failure says nothing was created", async () => {
    mocks.createSpecCore.mockResolvedValue({ ok: false, error: "link_failed" })
    expect((await createSpec({ workspaceId: WS, scopeType: "SOLUTION", scopeId: SCOPE })).content[0].text).toMatch(/nothing was created/)
  })
})

describe("list_specs", () => {
  it("lists id, title, path, label, updatedAt and url for each spec, in the order the core returned", async () => {
    mocks.listSpecDocs.mockResolvedValue([
      { id: DOC, title: "Spec - A", label: "v1", template: "spec@1", updatedAt: new Date("2026-01-02T00:00:00Z") },
      { id: "44444444-4444-4444-8444-444444444444", title: "Spec - A", label: null, template: "spec@1", updatedAt: new Date("2026-01-03T00:00:00Z") },
    ])
    mocks.listPaths.mockResolvedValue([{ docId: DOC, path: "Spec - A" }, { docId: "44444444-4444-4444-8444-444444444444", path: "Spec - A (44444444)" }])
    const result = await listSpecs({ workspaceId: WS, scopeType: "SOLUTION", scopeId: SCOPE })
    const data = result.structuredContent.data as { count: number; items: Record<string, unknown>[] }
    expect(data.count).toBe(2)
    expect(data.items.map((i) => [i.id, i.path, i.label])).toEqual([[DOC, "Spec - A", "v1"], ["44444444-4444-4444-8444-444444444444", "Spec - A (44444444)", null]])
    expect(data.items[0]).toHaveProperty("updatedAt", "2026-01-02T00:00:00.000Z")
    expect(data.items[0]).toHaveProperty("url")
  })

  it("an empty scope is a normal empty result", async () => {
    mocks.listSpecDocs.mockResolvedValue([])
    expect((await listSpecs({ workspaceId: WS, scopeType: "OPPORTUNITY", scopeId: SCOPE })).structuredContent).toMatchObject({ ok: true, data: { items: [], count: 0 } })
  })

  it("a scope outside the workspace is the same not-found failure as create_spec", async () => {
    mocks.listSpecDocs.mockResolvedValue(null)
    expect((await listSpecs({ workspaceId: WS, scopeType: "OPPORTUNITY", scopeId: SCOPE })).structuredContent).toMatchObject({ ok: false, message: "Opportunity not found in this workspace." })
  })
})
