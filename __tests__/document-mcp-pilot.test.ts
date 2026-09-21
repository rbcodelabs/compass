import { beforeEach, describe, expect, it, vi } from "vitest"
import { runWithMcpActor } from "@/lib/mcp-authz"
const mocks = vi.hoisted(() => ({
  db: { workspace: { findUnique: vi.fn() }, doc: { findUnique: vi.fn(), findFirst: vi.fn() } },
  create: vi.fn(), update: vi.fn(), hydrate: vi.fn(),
}))
vi.mock("@/lib/db", () => ({ default: () => mocks.db }))
vi.mock("@/lib/document-storage", () => ({ isDocumentPilotWorkspace: () => true }))
vi.mock("@/lib/document-service", () => ({ createDocument: mocks.create, updateDocument: mocks.update, hydrateDocument: mocks.hydrate }))
import { createDoc, updateDoc, getDoc } from "@/lib/doc-tool-handlers"

const actor = { userId: null, purpose: "AGENT" as const, agentId: "agent-a" }
const doc = { id: "doc-a", title: "Synthetic", workspaceId: "workspace-a", storageProvider: "GEODE", revision: "revision-a", contentRef: "private-reference", content: null, metadata: null, icon: null, docType: "STANDARD", updatedAt: new Date(), parent: null, children: [] }
beforeEach(() => {
  vi.clearAllMocks()
  mocks.db.workspace.findUnique.mockResolvedValue({ name: "Synthetic", slug: "synthetic", organization: { slug: "test" } })
  mocks.db.doc.findUnique.mockResolvedValue(doc)
  mocks.db.doc.findFirst.mockResolvedValue({ sortOrder: 4 })
  mocks.create.mockResolvedValue(doc)
  mocks.update.mockResolvedValue(doc)
  mocks.hydrate.mockResolvedValue({ ...doc, contentRef: undefined, content: "body" })
})
describe("Geode MCP pilot", () => {
  it("preserves exact plain markdown and binds create to authenticated actor", async () => {
    await runWithMcpActor(actor, () => createDoc({ workspaceId: "workspace-a", title: "Synthetic", content: "\uFEFF  body 日本語\n", operationId: "operation-a", roadmapItemId: "roadmap-a" }))
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ content: "\uFEFF  body 日本語\n" }), expect.objectContaining({ operationId: "operation-a", actorKey: "AGENT:agent-a" }))
    // Service owns receipt replay before mutable linked-brief/parent checks.
    expect(mocks.db.doc.findUnique).not.toHaveBeenCalled()
  })
  it("passes revision and stable retry ID to update without exposing storage references", async () => {
    const result = await runWithMcpActor(actor, () => updateDoc({ docId: "doc-a", content: "  body\n", expectedRevision: "revision-a", operationId: "operation-a" }))
    expect(mocks.update).toHaveBeenCalledWith("doc-a", expect.objectContaining({ content: "  body\n" }), expect.objectContaining({ expectedRevision: "revision-a", operationId: "operation-a", actorKey: "AGENT:agent-a" }))
    expect(JSON.stringify(result)).not.toContain("private-reference")
  })
  it("returns hydrated content and revision without a reference", async () => {
    const result = await getDoc({ docId: "doc-a" })
    expect(mocks.hydrate).toHaveBeenCalledWith("workspace-a", doc)
    expect(JSON.stringify(result)).toContain("revision-a")
    expect(JSON.stringify(result)).not.toContain("private-reference")
  })
})
