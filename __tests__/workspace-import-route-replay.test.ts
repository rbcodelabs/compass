import { expect, it, vi } from "vitest"
import { createHash } from "node:crypto"

const state = vi.hoisted(() => ({
  load: vi.fn().mockRejectedValue(new Error("staging already cleaned")),
  verify: vi.fn().mockReturnValue({ uploadId: "prepared-upload" }),
  result: vi.fn().mockResolvedValue({ workspaceId: "restored", alreadyImported: false }),
  db: {},
}))
vi.mock("@/auth", () => ({ auth: async () => ({ user: { id: "user" } }) }))
vi.mock("@/lib/permissions", () => ({
  isPermissionError: () => false,
  resolveOrgAdmin: async () => ({ organizationId: "org", prisma: state.db }),
}))
vi.mock("@/lib/artifact-storage", () => ({ getArtifactStorage: () => ({}) }))
vi.mock("@/lib/workspace-export/upload", () => ({
  verifyBundleReceipt: state.verify, loadStagedBundle: state.load, MAX_BUNDLE_BYTES: 1000,
}))
vi.mock("@/lib/workspace-export/receipt-binding", () => ({ readImportReceiptResult: state.result }))
vi.mock("@/lib/workspace-export/import", () => ({ importWorkspaceBundle: vi.fn(), WorkspaceImportError: Error }))
vi.mock("@/lib/workspace-export/blobs", () => ({ defaultBlobAdapters: vi.fn() }))

it("returns the committed result for a verified receipt before opening staging", async () => {
  const { POST } = await import("@/app/api/workspace-import/[orgSlug]/route")
  const res = await POST(new Request("http://localhost/import", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ receipt: "signed" }),
  }), { params: Promise.resolve({ orgSlug: "org" }) })
  expect(res.status).toBe(200)
  expect(await res.json()).toMatchObject({ ok: true, workspaceId: "restored" })
  expect(state.verify).toHaveBeenCalledWith("signed", "org", "user", expect.any(Number), "replay")
  expect(state.result).toHaveBeenCalledWith(state.db, {
    organizationId: "org", userId: "user", nonce: "prepared-upload", digest: createHash("sha256").update("signed").digest("hex"),
  })
  expect(state.load).not.toHaveBeenCalled()
})
