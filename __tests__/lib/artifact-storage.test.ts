import { afterEach, describe, expect, it, vi } from "vitest"

const blob = vi.hoisted(() => ({
  del: vi.fn(),
  get: vi.fn(),
  put: vi.fn(),
}))

vi.mock("@vercel/blob", () => blob)

afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllEnvs()
})

describe("artifact storage credential boundaries", () => {
  it("uses only the dedicated private capability pack token for every operation", async () => {
    vi.stubEnv("DATABASE_URL", "")
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "public-token")
    vi.stubEnv("BLOB_STORE_ID", "unrelated-store")
    vi.stubEnv("VERCEL_OIDC_TOKEN", "unrelated-oidc")
    vi.stubEnv("CAPABILITY_PACK_BLOB_READ_WRITE_TOKEN", " pack-private-token ")
    blob.put.mockResolvedValue({ pathname: "capability-packs/sha256/example.json" })
    blob.get.mockResolvedValue(null)
    const { getCapabilityPackArtifactStorage } = await import("@/lib/artifact-storage")
    const storage = getCapabilityPackArtifactStorage()
    await storage.put("capability-packs/sha256/example.json", new Uint8Array([1]), "application/json")
    expect(await storage.get("capability-packs/sha256/example.json")).toBeNull()
    await storage.del("capability-packs/sha256/example.json")
    expect(blob.put.mock.calls[0]?.[2]).toMatchObject({ token: "pack-private-token", access: "private" })
    expect(blob.get.mock.calls[0]?.[1]).toMatchObject({ token: "pack-private-token", access: "private" })
    expect(blob.del).toHaveBeenCalledWith("capability-packs/sha256/example.json", { token: "pack-private-token" })
  })

  it("never falls back to the public store when the pack token is absent", async () => {
    vi.stubEnv("DATABASE_URL", "")
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "public-token")
    vi.stubEnv("CAPABILITY_PACK_BLOB_READ_WRITE_TOKEN", "")
    const { getCapabilityPackArtifactStorage } = await import("@/lib/artifact-storage")
    expect(() => getCapabilityPackArtifactStorage()).toThrow("Private capability pack storage is not configured")
    expect(blob.get).not.toHaveBeenCalled()
  })

  it("propagates a private store400 failure rather than treating it as a missing artifact", async () => {
    vi.stubEnv("DATABASE_URL", "")
    vi.stubEnv("CAPABILITY_PACK_BLOB_READ_WRITE_TOKEN", "pack-private-token")
    blob.get.mockRejectedValueOnce(new Error("Failed to fetch blob: 400 Bad Request"))
    const { getCapabilityPackArtifactStorage } = await import("@/lib/artifact-storage")
    await expect(getCapabilityPackArtifactStorage().get("capability-packs/sha256/example.json")).rejects.toThrow("400 Bad Request")
    expect(blob.put).not.toHaveBeenCalled()
  })
  it("provides a separate storage accessor for private research blobs", async () => {
    const storageModule = await import("@/lib/artifact-storage")

    expect(storageModule).toHaveProperty("getResearchArtifactStorage")
  })

  it("passes the dedicated research token to every private Blob operation", async () => {
    vi.stubEnv("DATABASE_URL", "")
    vi.stubEnv("RESEARCH_BLOB_READ_WRITE_TOKEN", "research-token-for-test")
    blob.put.mockResolvedValue({ pathname: "research/workspace/study/session/file.png" })
    blob.get.mockResolvedValue({
      statusCode: 200,
      stream: new Response(new Uint8Array([1, 2, 3])).body,
    })
    const { getResearchArtifactStorage } = await import("@/lib/artifact-storage")
    const storage = getResearchArtifactStorage()

    await storage.put("research/workspace/study/session/file.png", new Uint8Array([1]), "image/png")
    await storage.get("research/workspace/study/session/file.png")
    await storage.del("research/workspace/study/session/file.png")

    expect(blob.put).toHaveBeenCalledWith(
      "research/workspace/study/session/file.png",
      expect.any(Buffer),
      expect.objectContaining({ token: "research-token-for-test" }),
    )
    expect(blob.get).toHaveBeenCalledWith(
      "research/workspace/study/session/file.png",
      expect.objectContaining({ token: "research-token-for-test" }),
    )
    expect(blob.del).toHaveBeenCalledWith(
      "research/workspace/study/session/file.png",
      { token: "research-token-for-test" },
    )
  })

  it("fails closed when deployed research Blob storage has no dedicated token", async () => {
    vi.stubEnv("DATABASE_URL", "")
    vi.stubEnv("RESEARCH_BLOB_READ_WRITE_TOKEN", "")
    const { getResearchArtifactStorage } = await import("@/lib/artifact-storage")

    expect(() => getResearchArtifactStorage()).toThrow("Research Blob storage is not configured")
    expect(blob.put).not.toHaveBeenCalled()
    expect(blob.get).not.toHaveBeenCalled()
    expect(blob.del).not.toHaveBeenCalled()
  })

  it("leaves existing artifact Blob operations on the implicit public token", async () => {
    vi.stubEnv("DATABASE_URL", "")
    vi.stubEnv("RESEARCH_BLOB_READ_WRITE_TOKEN", "research-token-for-test")
    blob.put.mockResolvedValue({ pathname: "artifacts/workspace/prototype.html" })
    blob.get.mockResolvedValue({
      statusCode: 200,
      stream: new Response(new Uint8Array([1, 2, 3])).body,
    })
    const { getArtifactStorage } = await import("@/lib/artifact-storage")
    const storage = getArtifactStorage()

    await storage.put("artifacts/workspace/prototype.html", new Uint8Array([1]))
    await storage.get("artifacts/workspace/prototype.html")
    await storage.del("artifacts/workspace/prototype.html")

    expect(blob.put.mock.calls[0]?.[2]).not.toHaveProperty("token")
    expect(blob.get.mock.calls[0]?.[1]).not.toHaveProperty("token")
    expect(blob.del).toHaveBeenCalledWith("artifacts/workspace/prototype.html")
  })
})
