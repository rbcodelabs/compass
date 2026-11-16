import { randomUUID } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { getArtifactStorage } from "@/lib/artifact-storage"

const text = (b: Uint8Array | null) => (b ? new TextDecoder().decode(b) : null)
const enc = (s: string) => new TextEncoder().encode(s)

describe("ArtifactStorage.put({ overwrite: false }) on local storage", () => {
  const path = `test-no-overwrite/${randomUUID()}/object.txt`
  beforeEach(() => {
    vi.stubEnv("DATABASE_URL", "postgres://localhost/unused")
    vi.stubEnv("VERCEL", "")
  })
  afterEach(async () => {
    await getArtifactStorage().del(path)
    vi.unstubAllEnvs()
  })

  it("creates a missing object and reports created", async () => {
    const storage = getArtifactStorage()
    expect(await storage.put(path, enc("first"), "text/plain", { overwrite: false })).toEqual({ pathname: path, created: true })
    expect(text(await storage.get(path))).toBe("first")
  })

  it("leaves an existing object untouched and reports created: false", async () => {
    const storage = getArtifactStorage()
    await storage.put(path, enc("original"))
    expect(await storage.put(path, enc("replacement"), "text/plain", { overwrite: false })).toEqual({ pathname: path, created: false })
    expect(text(await storage.get(path))).toBe("original")
  })

  it("still overwrites by default", async () => {
    const storage = getArtifactStorage()
    await storage.put(path, enc("one"))
    await storage.put(path, enc("two"))
    expect(text(await storage.get(path))).toBe("two")
  })
})
