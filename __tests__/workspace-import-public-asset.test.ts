import { expect, it, vi } from "vitest"
import { copyPublicImportAsset } from "@/lib/workspace-export/public-import-asset"

it("reserves the public key and verifies the returned location and bytes before accepting the attachment", async () => {
  const physical = "feedback/workspace/attempt-file"
  const url = "https://fixture.public.blob.vercel-storage.com/" + physical
  const bytes = new Uint8Array([4])
  const calls: string[] = []
  const journal = {
    reserve: vi.fn(async () => { calls.push("reserve"); return physical }),
    verify: vi.fn(async () => { calls.push("verify") }),
  }
  const blobs = {
    putPublic: vi.fn(async () => { calls.push("put"); return url }),
    fetchPublic: vi.fn(async () => { calls.push("read"); return { bytes, contentType: "image/png" } }),
  }
  const copy = () => copyPublicImportAsset(blobs, journal, "logical", bytes, "image/png", "fixture.public.blob.vercel-storage.com")
  expect(await copy()).toBe(url)
  expect(calls).toEqual(["reserve","put","read","verify"])
  expect(blobs.putPublic).toHaveBeenCalledWith(physical,bytes,"image/png")
  blobs.fetchPublic.mockResolvedValueOnce({ bytes: new Uint8Array([9]), contentType: "image/png" })
  await expect(copy()).rejects.toThrow(/verification/i)
  blobs.putPublic.mockResolvedValueOnce("https://other.invalid/changed")
  await expect(copy()).rejects.toThrow(/location/i)
  expect(journal.verify).toHaveBeenCalledTimes(1)
  expect(blobs.fetchPublic).toHaveBeenCalledTimes(2)
})
