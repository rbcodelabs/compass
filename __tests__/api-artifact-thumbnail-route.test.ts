import { beforeEach, describe, expect, it, vi } from "vitest"

const auth = vi.fn()
const resolveWorkspaceAccess = vi.fn()
const storage = { get: vi.fn() }
const prisma = { artifactRevision: { findFirst: vi.fn() } }

vi.mock("@/auth", () => ({ auth: () => auth() }))
vi.mock("@/lib/db", () => ({ default: () => prisma }))
vi.mock("@/lib/artifact-storage", () => ({ getArtifactStorage: () => storage }))
vi.mock("@/lib/workspace-context", () => ({
  resolveWorkspaceAccess: (...args: unknown[]) => resolveWorkspaceAccess(...args),
}))

import { GET } from "@/app/api/artifacts/[artifactId]/revisions/[revisionId]/thumbnail/route"

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

function call(artifactId = "art-1", revisionId = "rev-1") {
  return GET(new Request("http://localhost/x"), { params: Promise.resolve({ artifactId, revisionId }) })
}

function revisionRow(overrides: Record<string, unknown> = {}) {
  return {
    thumbnailPathname: "artifacts/ws-1/art-1/thumbnails/rev-1-x.png",
    thumbnailMimeType: "image/png",
    artifact: { workspaceId: "ws-1", workspace: { slug: "preview", organization: { slug: "bankrate" } } },
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  auth.mockResolvedValue({ user: { id: "user-1" } })
  prisma.artifactRevision.findFirst.mockResolvedValue(revisionRow())
  resolveWorkspaceAccess.mockResolvedValue({ workspaceId: "ws-1" })
  storage.get.mockResolvedValue(PNG)
})

describe("GET artifact revision thumbnail", () => {
  it("serves the PNG to a reader of the workspace with locked-down headers", async () => {
    const response = await call()
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("image/png")
    expect(response.headers.get("content-length")).toBe(String(PNG.byteLength))
    expect(response.headers.get("cache-control")).toBe("private, no-store")
    expect(response.headers.get("x-content-type-options")).toBe("nosniff")
    expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox")
    expect(response.headers.get("content-disposition")).toBe('inline; filename="artifact-art-1-thumbnail.png"')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG)
    // Scoped to the artifact in the URL, so a revision id from another artifact misses.
    expect(prisma.artifactRevision.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "rev-1", artifactId: "art-1" } })
    )
    expect(resolveWorkspaceAccess).toHaveBeenCalledWith("bankrate", "preview", "user-1")
    expect(storage.get).toHaveBeenCalledWith("artifacts/ws-1/art-1/thumbnails/rev-1-x.png")
  })

  it("never echoes a non-PNG stored mime type", async () => {
    prisma.artifactRevision.findFirst.mockResolvedValue(revisionRow({ thumbnailMimeType: "text/html" }))
    const response = await call()
    expect(response.headers.get("content-type")).toBe("application/octet-stream")
  })

  it("does not put the storage pathname in the response", async () => {
    const response = await call()
    const headers = JSON.stringify([...response.headers.entries()])
    expect(headers).not.toContain("thumbnails/")
  })

  const misses: Array<[string, () => void]> = [
    ["there is no session", () => auth.mockResolvedValue(null)],
    ["the revision does not exist for that artifact", () => prisma.artifactRevision.findFirst.mockResolvedValue(null)],
    ["the revision has no thumbnail", () => prisma.artifactRevision.findFirst.mockResolvedValue(revisionRow({ thumbnailPathname: null }))],
    ["the reader has no workspace access", () => resolveWorkspaceAccess.mockResolvedValue(null)],
    ["the slugs now resolve to a different workspace", () => resolveWorkspaceAccess.mockResolvedValue({ workspaceId: "ws-other" })],
    ["the bytes are gone from storage", () => storage.get.mockResolvedValue(null)],
  ]
  it.each(misses)("returns a plain 404 when %s", async (_label, arrange) => {
    arrange()
    const response = await call()
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: "Not found" })
  })

  it("does not read storage before the access check passes", async () => {
    resolveWorkspaceAccess.mockResolvedValue(null)
    await call()
    expect(storage.get).not.toHaveBeenCalled()
  })
})
