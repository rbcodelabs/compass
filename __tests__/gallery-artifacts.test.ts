import { describe, expect, it, vi } from "vitest"
import { MAX_GALLERY_ARTIFACTS_PER_ITEM, isCapturableSource } from "@/lib/gallery/artifacts"
import { loadGalleryArtifactSets } from "@/lib/gallery/artifacts-server"

vi.mock("@/lib/links/read-mode", () => ({ getLinkReadMode: () => "off" }))

const rev = (id: string, thumb: boolean) => ({ id, thumbnailPathname: thumb ? "p" : null, thumbnailWidth: thumb ? 800 : null, thumbnailHeight: thumb ? 500 : null, thumbnailCapturedAt: thumb ? new Date(5) : null })
const row = (id: string, over: Record<string, unknown> = {}) => ({ id, title: id, sourceType: "HTML_UPLOAD", kind: null, currentRevision: null, ...over })

// Hand-rolled partial Prisma transaction client: only the delegate the shared loader touches is stubbed.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dbWith = (rows: unknown[]): any => ({ artifact: { findMany: vi.fn(async () => rows) } })

describe("isCapturableSource", () => {
  it("allows HTML uploads and external links only", () => {
    expect(isCapturableSource("HTML_UPLOAD")).toBe(true)
    expect(isCapturableSource("EXTERNAL_LINK")).toBe(true)
    expect(isCapturableSource("V0_CHAT")).toBe(false)
  })
})

describe("loadGalleryArtifactSets", () => {
  it("runs one workspace-scoped, ACTIVE-only artifact query for any number of owners", async () => {
    const db = dbWith([row("a1"), row("a2")])
    await loadGalleryArtifactSets(db, "ws", new Map([["o1", ["a1"]], ["o2", ["a2"]], ["o3", ["a1", "a2"]]]))
    expect(db.artifact.findMany).toHaveBeenCalledTimes(1)
    const { where } = db.artifact.findMany.mock.calls[0][0]
    expect(where).toMatchObject({ workspaceId: "ws", status: "ACTIVE" })
    expect([...where.id.in].sort()).toEqual(["a1", "a2"])
  })

  it("makes no query when no owner has an artifact, and still returns an empty set per owner", async () => {
    const db = dbWith([])
    const out = await loadGalleryArtifactSets(db, "ws", new Map([["o1", []]]))
    expect(db.artifact.findMany).not.toHaveBeenCalled()
    expect(out.get("o1")).toEqual({ artifacts: [], moreArtifacts: 0 })
  })

  it("keeps the query's newest-first order per owner, de-duplicates, and drops artifacts the query filtered out", async () => {
    // The query returns newest first: a2, a1. a9 is archived (not returned).
    const db = dbWith([row("a2", { title: "Newer" }), row("a1", { title: "Older" })])
    const out = await loadGalleryArtifactSets(db, "ws", new Map([["o1", ["a1", "a9", "a2", "a1"]]]))
    expect(out.get("o1")!.artifacts.map((a) => a.id)).toEqual(["a2", "a1"])
  })

  it("shapes thumbnail, kind and capturability", async () => {
    const db = dbWith([
      row("a2", { sourceType: "EXTERNAL_LINK", currentRevision: rev("r2", false) }),
      row("a1", { kind: "SLIDE_DECK", currentRevision: rev("r1", true) }),
      row("a3", { sourceType: "V0_CHAT" }),
    ])
    const out = await loadGalleryArtifactSets(db, "ws", new Map([["o1", ["a1", "a2", "a3"]]]))
    const [a2, a1, a3] = out.get("o1")!.artifacts
    expect(a2).toMatchObject({ thumbnail: null, capturable: true, kind: "DOCUMENT" })
    expect(a1.thumbnail?.src).toBe("/api/artifacts/a1/revisions/r1/thumbnail?v=5")
    expect(a1.kind).toBe("SLIDE_DECK")
    expect(a3).toMatchObject({ thumbnail: null, capturable: false })
  })

  it("caps each owner at the maximum and reports the remainder", async () => {
    const ids = Array.from({ length: MAX_GALLERY_ARTIFACTS_PER_ITEM + 3 }, (_, i) => `x${i}`)
    const db = dbWith(ids.map((id) => row(id)))
    const out = await loadGalleryArtifactSets(db, "ws", new Map([["o1", ids], ["o2", ids.slice(0, 2)]]))
    expect(out.get("o1")!.artifacts).toHaveLength(MAX_GALLERY_ARTIFACTS_PER_ITEM)
    expect(out.get("o1")!.moreArtifacts).toBe(3)
    expect(out.get("o2")).toMatchObject({ moreArtifacts: 0 })
  })
})
