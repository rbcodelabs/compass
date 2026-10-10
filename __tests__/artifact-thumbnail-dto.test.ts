import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/db", () => ({ default: () => ({}) }))

import { toArtifactDetailDto, toThumbnailDto } from "@/lib/artifacts"

const capturedAt = new Date("2026-10-01T12:00:00Z")
const full = {
  id: "rev-1", thumbnailPathname: "artifacts/ws-1/art-1/thumbnails/rev-1-x.png",
  thumbnailWidth: 1280, thumbnailHeight: 1900, thumbnailCapturedAt: capturedAt,
}

describe("toThumbnailDto", () => {
  it("points at the authenticated route with a cache-busting capture stamp", () => {
    expect(toThumbnailDto("art-1", full)).toEqual({
      src: `/api/artifacts/art-1/revisions/rev-1/thumbnail?v=${capturedAt.getTime()}`,
      width: 1280, height: 1900, capturedAt: capturedAt.toISOString(),
    })
  })

  it("never exposes the storage pathname", () => {
    expect(JSON.stringify(toThumbnailDto("art-1", full))).not.toContain("thumbnails/")
  })

  it.each(["id", "thumbnailPathname", "thumbnailWidth", "thumbnailHeight", "thumbnailCapturedAt"] as const)(
    "is null when %s is missing", (field) => {
      expect(toThumbnailDto("art-1", { ...full, [field]: null })).toBeNull()
    }
  )
})

describe("toArtifactDetailDto thumbnail", () => {
  it("includes the thumbnail on the current revision without leaking pathnames", () => {
    const dto = toArtifactDetailDto({
      id: "art-1", title: "T", description: null, sourceType: "HTML_UPLOAD", status: "ACTIVE",
      currentRevision: { ...full, externalUrl: null, blobPathname: "artifacts/ws-1/art-1/rev-1.html" },
      revisions: [],
    })
    expect(dto.currentRevision?.thumbnail?.src).toContain("/api/artifacts/art-1/revisions/rev-1/thumbnail")
    expect(JSON.stringify(dto)).not.toContain("artifacts/ws-1")
  })
})
