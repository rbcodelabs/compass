/**
 * QA (stage 1): who may set Doc.kind through the updateDoc server action, and what it refuses.
 * A read-only org member has no WorkspaceMember row, so requireWorkspaceMember must stop them before updateDocument runs.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

const m = vi.hoisted(() => ({
  after: vi.fn(),
  auth: vi.fn(),
  revalidatePath: vi.fn(),
  updateDocument: vi.fn(),
  prisma: { workspace: { findFirst: vi.fn() }, doc: { findUnique: vi.fn() } },
}))

vi.mock("next/server", () => ({ after: m.after }))
vi.mock("next/cache", () => ({ revalidatePath: m.revalidatePath }))
vi.mock("@/auth", () => ({ auth: m.auth }))
vi.mock("@/lib/db", () => ({ default: () => m.prisma }))
vi.mock("@/lib/artifact-storage", () => ({ getArtifactStorage: () => ({ get: vi.fn(), put: vi.fn(), del: vi.fn() }) }))
vi.mock("@/lib/document-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/document-service")>()),
  updateDocument: m.updateDocument,
}))

import { updateDoc } from "@/app/[orgSlug]/[workspaceSlug]/docs/actions"

beforeEach(() => {
  vi.clearAllMocks()
  m.auth.mockResolvedValue({ user: { id: "user-1", name: "U" } })
  m.prisma.doc.findUnique.mockResolvedValue({ workspaceId: "ws-1" })
  m.prisma.workspace.findFirst.mockResolvedValue({ id: "ws-1" })
  m.updateDocument.mockResolvedValue({ id: "doc-1", revision: "r2" })
})

describe("updateDoc kind: authorization", () => {
  it("refuses a signed-out caller and writes nothing", async () => {
    m.auth.mockResolvedValue(null)
    await expect(updateDoc("doc-1", { kind: "ADR" }, "/x")).rejects.toThrow("Unauthorized")
    expect(m.updateDocument).not.toHaveBeenCalled()
  })

  it("refuses an org-wide read-only member (no WorkspaceMember row) and writes nothing", async () => {
    m.prisma.workspace.findFirst.mockResolvedValue(null)
    await expect(updateDoc("doc-1", { kind: "ADR" }, "/x")).rejects.toThrow("Workspace not found or access denied")
    expect(m.updateDocument).not.toHaveBeenCalled()
  })

  it("checks membership against the doc's own workspace, not a caller-supplied one", async () => {
    await updateDoc("doc-1", { kind: "NOTE" }, "/x")
    expect(m.prisma.workspace.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "ws-1", members: { some: { userId: "user-1" } } } }),
    )
  })

  it("refuses a doc that does not exist", async () => {
    m.prisma.doc.findUnique.mockResolvedValue(null)
    await expect(updateDoc("nope", { kind: "ADR" }, "/x")).rejects.toThrow("Document not found")
    expect(m.updateDocument).not.toHaveBeenCalled()
  })
})

describe("updateDoc kind: validation", () => {
  it.each(["adr", "SPEC", "PLAN", "DISCOVERY_PLAN", "", " ADR", "ADR ", "QA REPORT"])("refuses %j before any write", async (bad) => {
    await expect(updateDoc("doc-1", { kind: bad }, "/x")).rejects.toThrow("Invalid document change")
    expect(m.updateDocument).not.toHaveBeenCalled()
  })

  it.each([1, true, {}, []])("refuses non-string kind %j", async (bad) => {
    await expect(updateDoc("doc-1", { kind: bad as unknown as string }, "/x")).rejects.toThrow("Invalid document change")
    expect(m.updateDocument).not.toHaveBeenCalled()
  })

  it.each(["ADR", "QA_REPORT", "DESIGN", "NOTE"])("accepts %s", async (kind) => {
    await updateDoc("doc-1", { kind }, "/x")
    expect(m.updateDocument).toHaveBeenCalledWith("doc-1", { kind }, expect.anything())
  })

  it("null clears the kind", async () => {
    await updateDoc("doc-1", { kind: null }, "/x")
    expect(m.updateDocument.mock.calls[0][1]).toEqual({ kind: null })
  })

  it("an omitted kind leaves the column out of the change (a title save never clears it)", async () => {
    await updateDoc("doc-1", { title: "T" }, "/x")
    expect(m.updateDocument.mock.calls[0][1]).toEqual({ title: "T" })
    expect("kind" in m.updateDocument.mock.calls[0][1]).toBe(false)
  })

  it("an explicit undefined kind is the same as omitted", async () => {
    await updateDoc("doc-1", { title: "T", kind: undefined }, "/x")
    expect("kind" in m.updateDocument.mock.calls[0][1]).toBe(false)
  })
})
