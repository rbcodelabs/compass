/**
 * Geode pilot regression coverage for the docs-as-virtual-filesystem surface
 * (ADR 0019). Supersedes the old docId-addressed createDoc/updateDoc/getDoc
 * handler tests (removed with lib/doc-tool-handlers.ts) with equivalent
 * coverage through lib/doc-fs.ts + lib/doc-fs-tool-handlers.ts: exact plain
 * markdown round-trip preservation, actor binding on create, revision/
 * operationId pass-through without exposing storage references, and hydrated
 * read content without private references.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { runWithMcpActor } from "@/lib/mcp-authz"

const mocks = vi.hoisted(() => ({
  db: { workspace: { findUnique: vi.fn() }, doc: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() } },
  create: vi.fn(),
  update: vi.fn(),
  hydrate: vi.fn(),
}))
vi.mock("@/lib/db", () => ({ default: () => mocks.db }))
vi.mock("@/lib/document-storage", () => ({ isDocumentPilotWorkspace: () => true }))
vi.mock("@/lib/document-service", async () => {
  const actual = await vi.importActual<typeof import("@/lib/document-service")>("@/lib/document-service")
  return { ...actual, createDocument: mocks.create, updateDocument: mocks.update, hydrateDocument: mocks.hydrate }
})
import { writeDoc } from "@/lib/doc-fs-tool-handlers"
import * as docFs from "@/lib/doc-fs"

const actor = { userId: null, purpose: "AGENT" as const, agentId: "agent-a" }
const doc = {
  id: "doc-a",
  title: "Synthetic",
  workspaceId: "workspace-a",
  parentId: null,
  roadmapItemId: null,
  docType: "STANDARD",
  sortOrder: 0,
  storageProvider: "GEODE",
  revision: "revision-a",
  contentRef: "private-reference",
  content: null,
  metadata: null,
  icon: null,
  updatedAt: new Date("2026-01-01"),
  createdAt: new Date("2026-01-01"),
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.db.workspace.findUnique.mockResolvedValue({ id: "workspace-a" })
  mocks.db.doc.findUnique.mockResolvedValue(doc)
  mocks.db.doc.findFirst.mockResolvedValue(null)
  mocks.create.mockResolvedValue(doc)
  mocks.update.mockResolvedValue(doc)
  mocks.hydrate.mockResolvedValue({ ...doc, contentRef: undefined, content: "body" })
})

describe("Geode MCP pilot — docs as a virtual filesystem", () => {
  it("preserves exact plain markdown and binds create to authenticated actor", async () => {
    mocks.db.doc.findMany.mockResolvedValue([]) // path doesn't resolve yet -> create
    await runWithMcpActor(actor, () =>
      writeDoc({ workspaceId: "workspace-a", path: "Synthetic", content: "﻿  body 日本語\n", operationId: "operation-a" })
    )
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({ content: "﻿  body 日本語\n" }),
      expect.objectContaining({ operationId: "operation-a", actorKey: "AGENT:agent-a" })
    )
  })

  it("passes revision and stable retry ID to update without exposing storage references", async () => {
    mocks.db.doc.findMany.mockResolvedValue([doc]) // path resolves -> update
    const result = await runWithMcpActor(actor, () =>
      writeDoc({ workspaceId: "workspace-a", path: "Synthetic", content: "  body\n", expectedRevision: "revision-a", operationId: "operation-a" })
    )
    expect(mocks.update).toHaveBeenCalledWith(
      "doc-a",
      expect.objectContaining({ content: "  body\n" }),
      expect.objectContaining({ expectedRevision: "revision-a", operationId: "operation-a", actorKey: "AGENT:agent-a" })
    )
    expect(JSON.stringify(result)).not.toContain("private-reference")
  })

  it("returns hydrated content and revision without a reference via readPath", async () => {
    mocks.db.doc.findMany.mockResolvedValue([doc])
    const result = await docFs.readPath("workspace-a", "Synthetic")
    expect(mocks.hydrate).toHaveBeenCalledWith("workspace-a", doc)
    expect(JSON.stringify(result)).toContain("revision-a")
    expect(JSON.stringify(result)).not.toContain("private-reference")
  })
})
