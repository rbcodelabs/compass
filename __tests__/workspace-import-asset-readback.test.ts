import { expect, it, vi } from "vitest"
import { randomUUID } from "node:crypto"
import { getArtifactStorage } from "@/lib/artifact-storage"
const fake = vi.hoisted(() => ({ query: vi.fn(), get: vi.fn(), del: vi.fn() }))
vi.mock("@/lib/db", () => ({ default: () => ({ $queryRawUnsafe: fake.query }) }))
vi.mock("@vercel/blob", () => ({ get: fake.get, del: fake.del, put: vi.fn() }))

it("reads and deletes the winning physical Docs image through the standard artifact adapter", async () => {
  vi.stubEnv("VERCEL", "1")
  vi.stubEnv("ARTIFACT_BLOB_READ_WRITE_TOKEN", "fixture")
  try {
    const logical = "docs/" + randomUUID() + "/images/plot.png"
    fake.query.mockResolvedValue([{ physical_key: "attempt/winner/image" }])
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
