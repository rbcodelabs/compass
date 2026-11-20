import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const s3 = vi.hoisted(() => ({ putS3PublicFile: vi.fn(), deleteS3PublicFilesByUrl: vi.fn(), getPublicObject: vi.fn() }))
const blob = vi.hoisted(() => ({ delete: vi.fn(), fetch: vi.fn() }))
vi.mock("@/lib/storage/public-files", () => ({ putS3PublicFile: s3.putS3PublicFile, deleteS3PublicFilesByUrl: s3.deleteS3PublicFilesByUrl }))
vi.mock("@/lib/storage/s3", () => ({ getPublicObject: s3.getPublicObject }))
vi.mock("@/lib/storage/blob-public-store", () => ({ vercelBlobPublicFileStore: { delete: blob.delete, put: vi.fn(), fetch: blob.fetch } }))

import { isPublicFileKey } from "@/lib/public-file-keys"
import { publicKeyForPathname, s3PublicFileStore } from "@/lib/storage/s3-public-store"

const UUID = "0f8fad5b-d9cb-469f-a165-70867728950e"

describe("publicKeyForPathname", () => {
  it("replaces a timestamp lead with a UUID and sanitizes the name, yielding a servable key", () => {
    const key = publicKeyForPathname("feedback/ws1/1700000000000-my shot.png")
    expect(key).toMatch(/^feedback\/ws1\/[0-9a-f-]{36}-my_shot\.png$/)
    expect(isPublicFileKey(key)).toBe(true)
  })

  it("keeps a UUID the caller already chose", () => {
    expect(publicKeyForPathname(`feedback/ws1/${UUID}-a.png`)).toBe(`feedback/ws1/${UUID}-a.png`)
  })

  it("branding: UUID lead, name capped at 100 characters, fallback when empty", () => {
    const long = publicKeyForPathname(`branding/17-${"a".repeat(300)}.png`)
    expect(isPublicFileKey(long)).toBe(true)
    expect(long.split("/")[1]!.length).toBeLessThanOrEqual(36 + 1 + 100)
  })

  it("embed screenshots get a random capture suffix", () => {
    const key = publicKeyForPathname("embed-feedback/ws1/src1/capture.jpg")
    expect(key).toMatch(/^embed-feedback\/ws1\/src1\/capture-[0-9a-f-]{36}\.jpg$/)
    expect(isPublicFileKey(key)).toBe(true)
  })

  it("refuses a pathname that cannot become a servable key", () => {
    expect(() => publicKeyForPathname("embed-feedback/ws1/src1/other.txt")).toThrow()
  })
})

describe("s3PublicFileStore", () => {
  beforeEach(() => {
    s3.putS3PublicFile.mockReset().mockImplementation(async (i: { key: string }) => ({ url: `/api/files/public/${i.key}` }))
    s3.deleteS3PublicFilesByUrl.mockReset().mockResolvedValue(undefined)
    s3.getPublicObject.mockReset()
    blob.delete.mockReset().mockResolvedValue(undefined)
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "vercel_blob_rw_teststore_test")
  })
  afterEach(() => vi.unstubAllEnvs())

  it("stores bytes under the mapped key and returns the app route", async () => {
    const out = await s3PublicFileStore.put("feedback/ws1/1-a.png", new Blob(["hi"], { type: "image/png" }), { contentType: "image/png" })
    expect(out.url).toMatch(/^\/api\/files\/public\/feedback\/ws1\/[0-9a-f-]{36}-a\.png$/)
    const arg = s3.putS3PublicFile.mock.calls[0][0]
    expect(Array.from(arg.body)).toEqual([104, 105])
    expect(arg.contentType).toBe("image/png")
  })

  it("uses the Blob\x27s own type when no content type is given, and an explicit one wins", async () => {
    await s3PublicFileStore.put("branding/1-logo.svg", new Blob(["<svg/>"], { type: "image/svg+xml" }))
    expect(s3.putS3PublicFile.mock.calls[0][0].contentType).toBe("image/svg+xml")
    await s3PublicFileStore.put("branding/1-logo.svg", new Blob(["<svg/>"], { type: "image/svg+xml" }), { contentType: "image/png" })
    expect(s3.putS3PublicFile.mock.calls[1][0].contentType).toBe("image/png")
  })

  it("routes each URL to the store that owns it when deleting (history can mix Blob and S3 rows)", async () => {
    const route = `/api/files/public/feedback/ws1/${UUID}-a.png`
    const legacy = "https://teststore.public.blob.vercel-storage.com/feedback/ws1/old.png"
    await s3PublicFileStore.delete([route, legacy])
    expect(s3.deleteS3PublicFilesByUrl).toHaveBeenCalledWith([route])
    expect(blob.delete).toHaveBeenCalledWith([legacy])
  })

  it("still attempts the other store when one fails, then rethrows", async () => {
    s3.deleteS3PublicFilesByUrl.mockRejectedValue(new Error("s3 down"))
    await expect(s3PublicFileStore.delete([
      `/api/files/public/feedback/ws1/${UUID}-a.png`,
      "https://teststore.public.blob.vercel-storage.com/feedback/ws1/old.png",
    ])).rejects.toThrow("s3 down")
    expect(blob.delete).toHaveBeenCalled()
  })

  it("fetch reads an app-route URL back and returns null for anything else or a missing object", async () => {
    const route = `/api/files/public/feedback/ws1/${UUID}-a.png`
    s3.getPublicObject.mockResolvedValueOnce({ kind: "ok", result: { Body: { transformToByteArray: async () => new Uint8Array([1]) }, ContentType: "image/png" } })
    expect(await s3PublicFileStore.fetch(route)).toEqual({ bytes: new Uint8Array([1]), contentType: "image/png" })
    s3.getPublicObject.mockResolvedValueOnce({ kind: "not-found" })
    expect(await s3PublicFileStore.fetch(route)).toBeNull()
    expect(await s3PublicFileStore.fetch("https://elsewhere/x")).toBeNull()
  })

  it("reads historical feedback bytes from the configured Blob store", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "vercel_blob_rw_legacy_test")
    const url = "https://legacy.public.blob.vercel-storage.com/feedback/ws1/old.png"
    const object = { bytes: new Uint8Array([1]), contentType: "image/png" }
    blob.fetch.mockResolvedValueOnce(object)
    try {
      await expect(s3PublicFileStore.fetch(url)).resolves.toEqual(object)
      expect(blob.fetch).toHaveBeenCalledWith(url)
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
