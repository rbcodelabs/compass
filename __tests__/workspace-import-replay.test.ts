import { afterEach, expect, it, vi } from "vitest"
import { prepareBundleUpload, verifyBundleReceipt } from "@/lib/workspace-export/upload"

vi.mock("@/lib/storage/direct-upload", () => ({
  createDirectUpload: async () => ({ token: "fixture" }),
  privateDirectUploadConfigured: () => true,
}))

afterEach(() => vi.unstubAllEnvs())

it("authenticates replay after upload expiry without extending upload authority", async () => {
  vi.stubEnv("ARTIFACT_UPLOAD_RECEIPT_SECRET", "isolated-fixture")
  const issued = 1_000
  const hour = 60 * 60 * 1000
  const { receipt } = await prepareBundleUpload({ organizationId: "org", userId: "user", fileSize: 10 }, issued)
  expect(() => verifyBundleReceipt(receipt, "org", "user", issued + hour)).toThrow(/expired/)
  expect(verifyBundleReceipt(receipt, "org", "user", issued + hour, "replay")).toMatchObject({
    organizationId: "org",
    userId: "user",
    replayExpiresAt: issued + 24 * hour,
  })
  expect(() => verifyBundleReceipt(receipt, "org", "other", issued + hour, "replay")).toThrow(/does not belong/)
  expect(() => verifyBundleReceipt(receipt, "org", "user", issued + 25 * hour, "replay")).toThrow(/expired/)
})
