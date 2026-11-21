import { expect, it, vi } from "vitest"
import { randomUUID } from "node:crypto"
import { getArtifactStorage } from "@/lib/artifact-storage"
const fake = vi.hoisted(() => ({ query: vi.fn(), get: vi.fn(), del: vi.fn(), put: vi.fn() }))
vi.mock("@/lib/db", () => ({ default: () => ({ $queryRawUnsafe: fake.query }) }))
vi.mock("@vercel/blob", () => ({ get: fake.get, del: fake.del, put: fake.put }))

it("reads and deletes the winning physical Docs image through the standard artifact adapter", async () => {
  vi.stubEnv("VERCEL", "1")
  vi.stubEnv("ARTIFACT_BLOB_READ_WRITE_TOKEN", "vercel_blob_rw_fixture_test")
  try {
    const logical = "docs/" + randomUUID() + "/images/plot.png"
    fake.query.mockResolvedValue([{ provider_id: "blob", namespace_id: "fixture", physical_key: "attempt/winner/image" }])
    fake.get.mockResolvedValue({ statusCode: 200, stream: new Response("winner").body })
    const storage = getArtifactStorage()
    expect(new TextDecoder().decode((await storage.get(logical))!)).toBe("winner")
    await storage.del(logical)
    expect(fake.get.mock.calls[0][0]).toBe("attempt/winner/image")
    expect(fake.del.mock.calls[0][0]).toBe("attempt/winner/image")
  } finally {
    vi.unstubAllEnvs()
  }
})

it("preserves create-only semantics for a published managed path and refuses to overwrite it", async () => {
  vi.stubEnv("VERCEL", "1")
  vi.stubEnv("ARTIFACT_BLOB_READ_WRITE_TOKEN", "vercel_blob_rw_fixture_test")
  try {
    const logical = "docs/" + randomUUID() + "/images/managed.png"
    fake.query.mockResolvedValue([{ provider_id: "blob", namespace_id: "fixture", physical_key: "attempt/managed" }])
    fake.get.mockResolvedValueOnce({ statusCode: 200, stream: new Response("existing").body })
    const storage = getArtifactStorage()
    await expect(storage.put(logical, new Uint8Array([1]), "image/png", { overwrite: false })).resolves.toEqual({ pathname: logical, created: false })
    await expect(storage.put(logical, new Uint8Array([2]))).rejects.toThrow(/overwrite/i)
  } finally {
    vi.unstubAllEnvs()
  }
})

it("recreates deleted managed bytes at the winning physical key", async () => {
  vi.stubEnv("VERCEL", "1")
  vi.stubEnv("ARTIFACT_BLOB_READ_WRITE_TOKEN", "vercel_blob_rw_fixture_test")
  try {
    const logical = "docs/" + randomUUID() + "/images/recreate.png"
    const physical = "attempt/verified"
    const bytes = Buffer.from("original")
    const { createHash } = await import("node:crypto")
    fake.query.mockResolvedValue([{ provider_id: "blob", namespace_id: "fixture", physical_key: physical, expected_sha256: createHash("sha256").update(bytes).digest("hex") }])
    let stored: Buffer | null = bytes
    fake.del.mockImplementation(async () => { stored = null })
    fake.put.mockImplementation(async (key, data) => {
      expect(key).toBe(physical)
      stored = Buffer.from(data)
      return { pathname: physical }
    })
    fake.get.mockImplementation(async () => stored && ({ statusCode: 200, stream: new Response(new Uint8Array(stored)).body }))
    const storage = getArtifactStorage()
    await storage.del(logical)
    expect(await storage.get(logical)).toBeNull()
    expect(await storage.put(logical, bytes, "image/png", { overwrite: false })).toEqual({ pathname: logical, created: true })
    expect(Buffer.from((await storage.get(logical))!)).toEqual(bytes)
  } finally { vi.unstubAllEnvs() }
})
