import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const client = vi.hoisted(() => ({ generateClientTokenFromReadWriteToken: vi.fn(), put: vi.fn() }))
vi.mock("@vercel/blob/client", () => client)

import { createDirectUploadToken, privateDirectUploadConfigured } from "@/lib/storage/direct-upload"
import { uploadToTarget } from "@/lib/storage/direct-upload-client"

const base = { pathname: "a/b.html", allowedContentTypes: ["text/html"], maxBytes: 10, validUntil: 123 }

describe("direct upload (server)", () => {
  beforeEach(() => {
    client.generateClientTokenFromReadWriteToken.mockReset().mockResolvedValue("tok")
    vi.stubEnv("ARTIFACT_BLOB_READ_WRITE_TOKEN", "")
  })
  afterEach(() => vi.unstubAllEnvs())

  it("private store: scopes the credential and uses the artifact token", async () => {
    vi.stubEnv("ARTIFACT_BLOB_READ_WRITE_TOKEN", " secret ")
    expect(privateDirectUploadConfigured()).toBe(true)
    await expect(createDirectUploadToken({ ...base, store: "private", allowOverwrite: false })).resolves.toBe("tok")
    expect(client.generateClientTokenFromReadWriteToken).toHaveBeenCalledWith({
      token: "secret", pathname: "a/b.html", allowedContentTypes: ["text/html"], maximumSizeInBytes: 10,
      validUntil: 123, addRandomSuffix: false, allowOverwrite: false,
    })
  })

  it("private store: fails with the caller's message when not configured", async () => {
    expect(privateDirectUploadConfigured()).toBe(false)
    await expect(createDirectUploadToken({ ...base, store: "private" })).rejects.toThrow("Private artifact storage is not configured")
    await expect(createDirectUploadToken({ ...base, store: "private", notConfiguredMessage: "Direct upload is not configured" })).rejects.toThrow("Direct upload is not configured")
    expect(client.generateClientTokenFromReadWriteToken).not.toHaveBeenCalled()
  })

  it("public store: uses the ambient token (no explicit token) and omits an unset allowOverwrite", async () => {
    await createDirectUploadToken({ ...base, store: "public" })
    const arg = client.generateClientTokenFromReadWriteToken.mock.calls[0][0]
    expect(arg).not.toHaveProperty("token")
    expect(arg).not.toHaveProperty("allowOverwrite")
  })
})

describe("direct upload (browser)", () => {
  it("puts the file with the issued credential and reports progress", async () => {
    client.put.mockReset().mockResolvedValue({ url: "https://s/x" })
    const onProgress = vi.fn()
    const file = new Blob(["x"])
    const out = await uploadToTarget({ pathname: "p", clientToken: "t", access: "private" }, file, { contentType: "application/zip", onProgress })
    expect(out).toEqual({ url: "https://s/x" })
    const [pathname, body, options] = client.put.mock.calls[0]
    expect([pathname, body]).toEqual(["p", file])
    expect(options).toMatchObject({ access: "private", token: "t", contentType: "application/zip" })
    options.onUploadProgress({ percentage: 40 })
    expect(onProgress).toHaveBeenCalledWith(40)
  })
})
