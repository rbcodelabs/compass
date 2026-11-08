import { beforeEach, describe, expect, it, vi } from "vitest"

const blob = vi.hoisted(() => ({ put: vi.fn(), del: vi.fn() }))
vi.mock("@vercel/blob", () => blob)

import { getPublicFileStore, vercelBlobPublicFileStore } from "@/lib/storage/public-store"

describe("public file store (Vercel Blob implementation)", () => {
  beforeEach(() => {
    blob.put.mockReset().mockResolvedValue({ url: "https://x.public.blob.vercel-storage.com/a.png" })
    blob.del.mockReset().mockResolvedValue(undefined)
  })

  it("is the active store", () => {
    expect(getPublicFileStore()).toBe(vercelBlobPublicFileStore)
  })

  it("stores bytes as public and returns the URL, passing only the options it was given", async () => {
    const out = await getPublicFileStore().put("feedback/w1/a.png", new Uint8Array([1, 2, 3]), { contentType: "image/png", addRandomSuffix: false })
    expect(out).toEqual({ url: "https://x.public.blob.vercel-storage.com/a.png" })
    const [pathname, body, options] = blob.put.mock.calls[0]
    expect(pathname).toBe("feedback/w1/a.png")
    expect(Buffer.isBuffer(body)).toBe(true)
    expect(options).toEqual({ access: "public", contentType: "image/png", addRandomSuffix: false })
  })

  it("passes a Blob through untouched and omits unset options", async () => {
    const file = new Blob(["hi"], { type: "text/plain" })
    await getPublicFileStore().put("branding/x", file)
    const [, body, options] = blob.put.mock.calls[0]
    expect(body).toBe(file)
    expect(options).toEqual({ access: "public" })
  })

  it("deletes by URL and skips the call for an empty list", async () => {
    await getPublicFileStore().delete([])
    expect(blob.del).not.toHaveBeenCalled()
    await getPublicFileStore().delete(["u1", "u2"])
    expect(blob.del).toHaveBeenCalledWith(["u1", "u2"])
  })

  it("fetches an object by URL, and returns null when it is gone", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
    fetchMock.mockResolvedValueOnce(new Response("abc", { headers: { "content-type": "image/png" } }))
    const got = await getPublicFileStore().fetch("https://x/a.png")
    expect(got?.contentType).toBe("image/png")
    expect(Array.from(got!.bytes)).toEqual([97, 98, 99])
    fetchMock.mockResolvedValueOnce(new Response("nope", { status: 404 }))
    expect(await getPublicFileStore().fetch("https://x/gone")).toBeNull()
    fetchMock.mockRestore()
  })
})
