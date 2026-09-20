import { beforeEach, describe, expect, it, vi } from "vitest"

const clientToken = vi.hoisted(() => vi.fn())

vi.mock("@vercel/blob/client", () => ({
  generateClientTokenFromReadWriteToken: clientToken,
}))

import {
  DOC_IMAGE_MAX_BYTES,
  buildDocImageReadUrl,
  createDocImage,
  prepareDocImageUpload,
  resolveDocImage,
} from "@/lib/doc-images"

const storage = {
  put: vi.fn(),
  get: vi.fn(),
  del: vi.fn(),
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.unstubAllEnvs()
})

describe("Docs image storage", () => {
  it("writes raster images to a random workspace-private pathname and returns an authorized read URL", async () => {
    storage.put.mockImplementation(async (pathname: string) => ({ pathname }))

    const result = await createDocImage({
      workspaceId: "11111111-1111-4111-8111-111111111111",
      filename: "QA shot (1).png",
      fileType: "image/png",
      bytes: new Uint8Array([1, 2, 3]),
    }, storage)

    expect(result.pathname).toMatch(/^docs\/11111111-1111-4111-8111-111111111111\/images\/[0-9a-f-]{36}\.png$/)
    expect(result.url).toBe(buildDocImageReadUrl("11111111-1111-4111-8111-111111111111", result.imageName))
    expect(storage.put).toHaveBeenCalledWith(result.pathname, new Uint8Array([1, 2, 3]), "image/png")
  })

  it.each(["image/svg+xml", "text/html", "application/pdf"])("rejects unsafe file type %s", async (fileType) => {
    await expect(createDocImage({
      workspaceId: "11111111-1111-4111-8111-111111111111",
      filename: "unsafe",
      fileType,
      bytes: new Uint8Array([1]),
    }, storage)).rejects.toThrow("Unsupported image type")
    expect(storage.put).not.toHaveBeenCalled()
  })

  it("rejects empty and oversized images before storage", async () => {
    await expect(createDocImage({ workspaceId: "ws", filename: "empty.png", fileType: "image/png", bytes: new Uint8Array() }, storage)).rejects.toThrow("empty")
    await expect(createDocImage({ workspaceId: "ws", filename: "large.png", fileType: "image/png", bytes: new Uint8Array(DOC_IMAGE_MAX_BYTES + 1) }, storage)).rejects.toThrow("10 MiB")
    expect(storage.put).not.toHaveBeenCalled()
  })

  it("prepares a short-lived private direct upload constrained to the exact path, type, and size", async () => {
    vi.stubEnv("ARTIFACT_BLOB_READ_WRITE_TOKEN", " private-artifact-token ")
    clientToken.mockResolvedValue("scoped-client-token")

    const result = await prepareDocImageUpload({
      workspaceId: "11111111-1111-4111-8111-111111111111",
      filename: "shot.jpg",
      fileType: "image/jpeg",
      fileSize: 1234,
    }, 1_789_900_000_000)

    expect(result).toMatchObject({ clientToken: "scoped-client-token", access: "private", fileType: "image/jpeg", fileSize: 1234 })
    expect(result.pathname).toMatch(/^docs\/11111111-1111-4111-8111-111111111111\/images\/[0-9a-f-]{36}\.jpg$/)
    expect(result.markdown).toBe(`![shot.jpg](${result.url})`)
    expect(clientToken).toHaveBeenCalledWith(expect.objectContaining({
      token: "private-artifact-token",
      pathname: result.pathname,
      allowedContentTypes: ["image/jpeg"],
      maximumSizeInBytes: 1234,
      addRandomSuffix: false,
      allowOverwrite: false,
    }))
  })

  it("never falls back to the public Blob credential for prepared uploads", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "public-token")
    vi.stubEnv("ARTIFACT_BLOB_READ_WRITE_TOKEN", "")
    await expect(prepareDocImageUpload({ workspaceId: "ws", filename: "shot.png", fileType: "image/png", fileSize: 1 })).rejects.toThrow("Private artifact storage is not configured")
    expect(clientToken).not.toHaveBeenCalled()
  })

  it("reconstructs only server-generated workspace paths and trusted MIME types", () => {
    expect(resolveDocImage("workspace-1", "123e4567-e89b-42d3-a456-426614174000.webp")).toEqual({
      pathname: "docs/workspace-1/images/123e4567-e89b-42d3-a456-426614174000.webp",
      fileType: "image/webp",
    })
    expect(resolveDocImage("workspace-1", "../../secret.png")).toBeNull()
    expect(resolveDocImage("workspace-1", "123e4567-e89b-42d3-a456-426614174000.svg")).toBeNull()
  })
})
