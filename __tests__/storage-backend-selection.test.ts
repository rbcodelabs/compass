import { afterEach, describe, expect, it, vi } from "vitest"
import { resolveStorageBackend, s3Config } from "@/lib/storage/config"
import { agentSessionStorageConfigured, getAgentSessionStorage, getArtifactStorage, getCapabilityPackArtifactStorage, getResearchArtifactStorage, shouldUseLocalStorage } from "@/lib/artifact-storage"
import { feedbackAttachmentsAvailable } from "@/lib/storage/availability"

type Env = Record<string, string | undefined>

/** Every input the selection looks at, so each row of the matrix states all of them. */
function env(overrides: Env): Env {
  return {
    COMPASS_STORAGE_BACKEND: undefined, VERCEL: undefined,
    DATABASE_URL: undefined, NODE_ENV: "production", ...overrides,
  }
}

describe("resolveStorageBackend: COMPASS_STORAGE_BACKEND unset keeps today's behavior", () => {
  // The rule upstream shipped before this setting: disk iff DATABASE_URL is set and the process is not on Vercel.
  const cases: Array<[string, Env, "blob" | "local"]> = [
    ["Vercel production, no DATABASE_URL", env({ VERCEL: "1" }), "blob"],
    ["Vercel never uses disk, even with DATABASE_URL (Supabase production)", env({ VERCEL: "1", DATABASE_URL: "postgres://x" }), "blob"],
    ["off Vercel without DATABASE_URL", env({}), "blob"],
    ["off Vercel with DATABASE_URL", env({ DATABASE_URL: "postgres://x" }), "local"],
    ["next dev", env({ DATABASE_URL: "postgres://x", NODE_ENV: "development" }), "local"],
    ["test runner", env({ DATABASE_URL: "postgres://x", NODE_ENV: "test" }), "local"],
  ]
  it.each(cases)("%s", (_name, e, expected) => {
    expect(resolveStorageBackend(e)).toBe(expected)
  })
})

describe("resolveStorageBackend: explicit COMPASS_STORAGE_BACKEND", () => {
  it("s3 wins over everything, including Vercel, a Blob token and development defaults", () => {
    for (const e of [
      env({ COMPASS_STORAGE_BACKEND: "s3" }),
      env({ COMPASS_STORAGE_BACKEND: "s3", DATABASE_URL: "postgres://x" }),
      env({ COMPASS_STORAGE_BACKEND: "s3", VERCEL: "1", DATABASE_URL: "postgres://x" }),
      env({ COMPASS_STORAGE_BACKEND: "s3", NODE_ENV: "development", DATABASE_URL: "postgres://x" }),
    ]) expect(resolveStorageBackend(e)).toBe("s3")
  })

  it("blob wins over development defaults and DATABASE_URL", () => {
    expect(resolveStorageBackend(env({ COMPASS_STORAGE_BACKEND: "blob", DATABASE_URL: "postgres://x" }))).toBe("blob")
    expect(resolveStorageBackend(env({ COMPASS_STORAGE_BACKEND: "blob", NODE_ENV: "development", DATABASE_URL: "postgres://x" }))).toBe("blob")
  })

  it("local works off Vercel with DATABASE_URL", () => {
    expect(resolveStorageBackend(env({ COMPASS_STORAGE_BACKEND: "local", DATABASE_URL: "postgres://x" }))).toBe("local")
  })

  it("local fails loudly on Vercel and without DATABASE_URL", () => {
    expect(() => resolveStorageBackend(env({ COMPASS_STORAGE_BACKEND: "local", VERCEL: "1", DATABASE_URL: "postgres://x" }))).toThrow(/not allowed on Vercel/)
    expect(() => resolveStorageBackend(env({ COMPASS_STORAGE_BACKEND: "local" }))).toThrow(/requires DATABASE_URL/)
  })

  it("is case-insensitive and trims, but rejects unknown values instead of guessing", () => {
    expect(resolveStorageBackend(env({ COMPASS_STORAGE_BACKEND: " S3 " }))).toBe("s3")
    expect(() => resolveStorageBackend(env({ COMPASS_STORAGE_BACKEND: "gcs" }))).toThrow(/must be "blob", "s3" or "local"/)
  })

  it("an empty value counts as unset", () => {
    expect(resolveStorageBackend(env({ COMPASS_STORAGE_BACKEND: "  ", VERCEL: "1" }))).toBe("blob")
  })
})

describe("s3Config", () => {
  it("requires a bucket and never invents a region", () => {
    expect(() => s3Config({})).toThrow(/COMPASS_S3_BUCKET/)
    expect(() => s3Config({ COMPASS_S3_BUCKET: "  " })).toThrow(/COMPASS_S3_BUCKET/)
    expect(s3Config({ COMPASS_S3_BUCKET: "compass-test-files" })).toEqual({ bucket: "compass-test-files", region: undefined, forcePathStyle: false })
  })
  it("reads the contract variables and the documented path-style switch", () => {
    expect(s3Config({ COMPASS_S3_BUCKET: "compass-test-files", COMPASS_S3_REGION: "us-east-1", COMPASS_S3_FORCE_PATH_STYLE: "1" })).toEqual({
      bucket: "compass-test-files", region: "us-east-1", forcePathStyle: true,
    })
  })
  it("rejects names that are not valid bucket names", () => {
    expect(() => s3Config({ COMPASS_S3_BUCKET: "Bad_Bucket" })).toThrow(/valid S3 bucket/)
    expect(() => s3Config({ COMPASS_S3_BUCKET: "a/b" })).toThrow(/valid S3 bucket/)
  })
})

describe("storage getters honor the selection", () => {
  afterEach(() => vi.unstubAllEnvs())

  function stub(e: Env) {
    for (const [k, v] of Object.entries(e)) vi.stubEnv(k, v ?? "")
  }

  it("s3 without a bucket fails loudly at first use, never falling back to Blob or disk", async () => {
    stub(env({ COMPASS_STORAGE_BACKEND: "s3", COMPASS_S3_BUCKET: "", DATABASE_URL: "postgres://x", ARTIFACT_BLOB_READ_WRITE_TOKEN: "tok" }))
    await expect(getArtifactStorage().get("a/b.html")).rejects.toThrow(/COMPASS_S3_BUCKET/)
    await expect(getArtifactStorage().put("a/b.html", new Uint8Array([1]))).rejects.toThrow(/COMPASS_S3_BUCKET/)
    await expect(getCapabilityPackArtifactStorage().get("a")).rejects.toThrow(/COMPASS_S3_BUCKET/)
    await expect(getResearchArtifactStorage().get("a")).rejects.toThrow(/COMPASS_S3_BUCKET/)
    await expect(getAgentSessionStorage().get("a")).rejects.toThrow(/COMPASS_S3_BUCKET/)
    expect(shouldUseLocalStorage()).toBe(false)
    expect(agentSessionStorageConfigured()).toBe(false)
    expect(feedbackAttachmentsAvailable()).toBe(false)
  })

  it("an invalid backend value throws from the getters and is never treated as local", () => {
    stub(env({ COMPASS_STORAGE_BACKEND: "nope", DATABASE_URL: "postgres://x", NODE_ENV: "development" }))
    expect(() => getArtifactStorage()).toThrow(/must be "blob", "s3" or "local"/)
    expect(shouldUseLocalStorage()).toBe(false)
  })

  it("s3 with a bucket needs no Blob token anywhere", () => {
    stub(env({
      COMPASS_STORAGE_BACKEND: "s3", COMPASS_S3_BUCKET: "compass-test-files",
      ARTIFACT_BLOB_READ_WRITE_TOKEN: "", CAPABILITY_PACK_BLOB_READ_WRITE_TOKEN: "", RESEARCH_BLOB_READ_WRITE_TOKEN: "",
      AGENT_SESSION_BLOB_READ_WRITE_TOKEN: "", BLOB_READ_WRITE_TOKEN: "",
    }))
    expect(() => getCapabilityPackArtifactStorage()).not.toThrow()
    expect(() => getResearchArtifactStorage()).not.toThrow()
    expect(() => getAgentSessionStorage()).not.toThrow()
    expect(agentSessionStorageConfigured()).toBe(true)
    expect(feedbackAttachmentsAvailable()).toBe(true)
  })

  it("blob keeps requiring its tokens, with the existing messages", async () => {
    stub(env({ COMPASS_STORAGE_BACKEND: "blob", ARTIFACT_BLOB_READ_WRITE_TOKEN: "", CAPABILITY_PACK_BLOB_READ_WRITE_TOKEN: "", RESEARCH_BLOB_READ_WRITE_TOKEN: "", AGENT_SESSION_BLOB_READ_WRITE_TOKEN: "", BLOB_READ_WRITE_TOKEN: "" }))
    await expect(getArtifactStorage().get("x")).rejects.toThrow("Private artifact storage is not configured")
    expect(() => getCapabilityPackArtifactStorage()).toThrow("Private capability pack storage is not configured")
    expect(() => getResearchArtifactStorage()).toThrow("Research Blob storage is not configured")
    expect(() => getAgentSessionStorage()).toThrow("Agent session storage is not configured")
    expect(feedbackAttachmentsAvailable()).toBe(false)
  })

  it("feedback attachments with Blob need only BLOB_READ_WRITE_TOKEN, as before", () => {
    stub(env({ BLOB_READ_WRITE_TOKEN: "tok", VERCEL: "1" }))
    expect(feedbackAttachmentsAvailable()).toBe(true)
  })
})
