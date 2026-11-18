import { afterEach, describe, expect, it, vi } from "vitest"
import { isPublicPath } from "@/lib/route-access"
import { getPublicFileStore, vercelBlobPublicFileStore } from "@/lib/storage/public-store"
import { s3PublicFileStore } from "@/lib/storage/s3-public-store"
import { feedbackAttachmentsAvailable } from "@/lib/storage/availability"

const KEY = "feedback/ws_1/0f8fad5b-d9cb-469f-a165-70867728950e-a.png"

describe("with COMPASS_STORAGE_BACKEND unset the Vercel Blob behavior is unchanged", () => {
  afterEach(() => vi.unstubAllEnvs())

  it("the public store is Vercel Blob, and S3 only when selected", () => {
    vi.stubEnv("COMPASS_STORAGE_BACKEND", "")
    vi.stubEnv("VERCEL", "1")
    expect(getPublicFileStore()).toBe(vercelBlobPublicFileStore)
    vi.stubEnv("COMPASS_STORAGE_BACKEND", "s3")
    expect(getPublicFileStore()).toBe(s3PublicFileStore)
  })

  it("feedback attachments need only BLOB_READ_WRITE_TOKEN", () => {
    vi.stubEnv("COMPASS_STORAGE_BACKEND", "")
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "")
    expect(feedbackAttachmentsAvailable()).toBe(false)
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "tok")
    expect(feedbackAttachmentsAvailable()).toBe(true)
  })

  it("only the exact public-file key shapes skip the login redirect; other /api/files paths do not", () => {
    expect(isPublicPath(`/api/files/public/${KEY}`)).toBe(true)
    expect(isPublicPath("/api/files/public/artifacts/ws/secret.html")).toBe(false)
    expect(isPublicPath("/api/files/private/anything")).toBe(false)
    expect(isPublicPath("/api/files")).toBe(false)
  })
})
