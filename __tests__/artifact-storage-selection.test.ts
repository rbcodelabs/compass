import { afterEach, describe, expect, it, vi } from "vitest"
import { getArtifactStorage, shouldUseLocalStorage } from "@/lib/artifact-storage"

describe("artifact storage selection", () => {
  afterEach(() => vi.unstubAllEnvs())

  it("uses local disk off Vercel when DATABASE_URL is set", () => {
    vi.stubEnv("DATABASE_URL", "postgres://x")
    vi.stubEnv("VERCEL", "")
    expect(shouldUseLocalStorage()).toBe(true)
  })

  it("never uses local disk on Vercel, even with DATABASE_URL (Supabase production)", () => {
    vi.stubEnv("DATABASE_URL", "postgres://x")
    vi.stubEnv("VERCEL", "1")
    expect(shouldUseLocalStorage()).toBe(false)
    vi.stubEnv("ARTIFACT_BLOB_READ_WRITE_TOKEN", "")
    return expect(getArtifactStorage().get("a/b.html")).rejects.toThrow("Private artifact storage is not configured")
  })
})
