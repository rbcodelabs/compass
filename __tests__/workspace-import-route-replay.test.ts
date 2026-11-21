import { expect, it, vi } from "vitest"
import { createHash } from "node:crypto"

const state = vi.hoisted(() => ({
  load: vi.fn().mockRejectedValue(new Error("staging already cleaned")),
  verify: vi.fn().mockReturnValue({ uploadId: "prepared-upload" }),
  result: vi.fn().mockResolvedValue({ workspaceId: "restored", alreadyImported: false }),
  db: {},
  apply: vi.fn(),
}))
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))
vi.mock("@/auth", () => ({ auth: async () => ({ user: { id: "user" } }) }))
vi.mock("@/lib/permissions", () => ({
  isPermissionError: () => false,
  resolveOrgAdmin: async () => ({ organizationId: "org", prisma: state.db }),
}))
vi.mock("@/lib/artifact-storage", () => ({ getArtifactStorage: () => ({}) }))
vi.mock("@/lib/workspace-export/upload", () => ({
  verifyBundleReceipt: state.verify, loadStagedBundle: state.load, MAX_BUNDLE_BYTES: 1000,
}))
vi.mock("@/lib/workspace-export/receipt-binding", () => ({ readImportReceiptResult: state.result, bindImportReceipt: vi.fn() }))
vi.mock("@/lib/workspace-export/import", () => ({ importWorkspaceBundle: state.apply, WorkspaceImportError: class extends Error {}, WorkspaceImportRecoveryRequired: class extends Error {} }))
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
    organizationId: "org", userId: "user", nonce: "prepared-upload", digest: createHash("sha256").update(JSON.stringify(["workspace-import", "org", "user", "prepared-upload"])).digest("hex"),
  })
  expect(state.load).not.toHaveBeenCalled()
})

it("keeps the ZIP when a duplicate publication has no durable report", async () => {
  state.result.mockResolvedValue(null)
  const discard = vi.fn()
  state.load.mockResolvedValue({ bytes: new Uint8Array([1]), discard })
  state.apply.mockResolvedValue({ workspaceId: "duplicate", alreadyImported: true })
  const { POST } = await import("@/app/api/workspace-import/[orgSlug]/route")
  const res = await POST(new Request("http://localhost/import", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ receipt: "signed" }),
  }), { params: Promise.resolve({ orgSlug: "org" }) })
  expect(discard).not.toHaveBeenCalled()
  expect(res.status).toBe(503)
})

it("uses the held operation after duplicate publication and verifies the winner in its transaction", async () => {
  const workspaceId = "b82be3e8-6553-4181-b216-fe32421b57fb"
  const owner = { workspaceId, attemptId: "7238c0cf-3418-4764-bc50-876af6686108", epoch: 3 }
  const report = { workspaceId, alreadyImported: true }
  const findFirst = vi.fn().mockResolvedValue({ id: workspaceId })
  const query = vi.fn().mockResolvedValueOnce([{ epoch: owner.epoch, phase: "applying" }]).mockResolvedValueOnce([{ phase: "applying", bundle_digest: "digest" }]).mockResolvedValue([{ epoch: owner.epoch }])
  const tx = { workspace: { findFirst }, $queryRawUnsafe: query }
  const claim = vi.fn().mockResolvedValueOnce([{ epoch: owner.epoch }]).mockResolvedValue([])
  Object.assign(state.db, { $queryRawUnsafe: claim, $transaction: (run: (client: typeof tx) => Promise<void>) => run(tx) })
  state.result.mockReset().mockResolvedValueOnce(null).mockResolvedValue(report)
  const discard = vi.fn()
  state.load.mockResolvedValue({ bytes: new Uint8Array([1]), discard })
  state.apply.mockImplementation(async (_db, _bytes, callbacks) => {
    await callbacks.startOperation(workspaceId, "digest")
    await callbacks.recordExisting(report, "digest")
    return report
  })
  const { POST } = await import("@/app/api/workspace-import/[orgSlug]/route")
  const res = await POST(new Request("http://localhost/import", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ receipt: "signed" }),
  }), { params: Promise.resolve({ orgSlug: "org" }) })
  expect(findFirst).toHaveBeenCalledWith({ where: { id: workspaceId, organizationId: "org" }, select: { id: true } })
  expect(query.mock.calls.filter(([sql]) => sql.includes("INSERT INTO"))).toHaveLength(1)
  const attempt = query.mock.calls[0][3]
  expect(query).toHaveBeenCalledWith(expect.stringContaining("UPDATE"), workspaceId, attempt, owner.epoch, JSON.stringify(report))
  expect(res.status).toBe(200)
  expect(discard).toHaveBeenCalledOnce()
})

it("keeps a fresh receipt unbound when its bytes differ from the committed operation", async () => {
  const { bindImportReceipt } = await import("@/lib/workspace-export/receipt-binding")
  vi.mocked(bindImportReceipt).mockClear()
  state.result.mockResolvedValue(null)
  const discard = vi.fn()
  state.load.mockResolvedValue({ bytes: new Uint8Array([2]), discard })
  const workspaceId = "fe1e28d3-2ecb-4638-88ff-b4c393ad701e"
  const tx = {
    workspace: { findFirst: vi.fn().mockResolvedValue({ id: workspaceId }) },
    $queryRawUnsafe: vi.fn().mockResolvedValue([{ phase: "committed", bundle_digest: "original" }]),
  }
  Object.assign(state.db, { $transaction: (fn: (db: typeof tx) => unknown) => fn(tx) })
  state.apply.mockImplementation(async (_db, _bytes, callbacks) => {
    await callbacks.recordExisting({ workspaceId }, "different")
  })
  const { POST } = await import("@/app/api/workspace-import/[orgSlug]/route")
  const res = await POST(new Request("http://localhost/import", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ receipt: "fresh" }),
  }), { params: Promise.resolve({ orgSlug: "org" }) })
  expect(res.status).toBe(422)
  expect(bindImportReceipt).not.toHaveBeenCalled()
  expect(discard).not.toHaveBeenCalled()
})
