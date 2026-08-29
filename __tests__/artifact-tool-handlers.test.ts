import { beforeEach, describe, expect, it, vi } from "vitest"

const storage = { put: vi.fn(), get: vi.fn(), del: vi.fn() }
const prisma = {
  workspace: { findUnique: vi.fn() },
  artifact: { findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
  artifactRevision: { findFirst: vi.fn(), create: vi.fn() },
  artifactLink: { findFirst: vi.fn() },
  solution: { findMany: vi.fn() },
  artifactBlobCleanup: { upsert: vi.fn() },
  $transaction: vi.fn(),
}

vi.mock("@/lib/db", () => ({ default: () => prisma }))
vi.mock("@/lib/artifact-storage", () => ({ getArtifactStorage: () => storage }))

import { getArtifact, updateArtifact } from "@/lib/artifact-tool-handlers"

beforeEach(() => {
  vi.clearAllMocks()
  prisma.$transaction.mockImplementation(async (callback) => callback(prisma))
  prisma.artifactRevision.findFirst.mockResolvedValue(null)
  storage.put.mockResolvedValue({ pathname: "artifacts/ws-1/art-1/rev-2.html" })
  storage.del.mockResolvedValue(undefined)
})

describe("Artifact MCP update validation", () => {
  it("rejects html and url together before reading or writing", async () => {
    const result = await updateArtifact({
      artifactId: "art-1", workspaceId: "ws-1", html: "<html></html>", url: "https://example.com",
    })
    expect(result.content[0].text).toMatch(/either html or url/i)
    expect(prisma.artifact.findFirst).not.toHaveBeenCalled()
    expect(prisma.artifact.update).not.toHaveBeenCalled()
  })

  it("rejects whitespace-only metadata before writing", async () => {
    const result = await updateArtifact({ artifactId: "art-1", workspaceId: "ws-1", title: "   " })
    expect(result.content[0].text).toMatch(/title is required/i)
    expect(prisma.artifact.findFirst).not.toHaveBeenCalled()
  })

  it("rejects a URL revision for an uploaded HTML Artifact", async () => {
    prisma.artifact.findFirst.mockResolvedValue({ id: "art-1", sourceType: "HTML_UPLOAD" })
    const result = await updateArtifact({ artifactId: "art-1", workspaceId: "ws-1", url: "https://example.com" })
    expect(result.content[0].text).toMatch(/accept html revisions/i)
    expect(prisma.artifact.update).not.toHaveBeenCalled()
  })

  it("updates HTML metadata, revision, and current pointer in one transaction", async () => {
    prisma.artifact.findFirst.mockResolvedValue({ id: "art-1", sourceType: "HTML_UPLOAD" })
    prisma.artifactRevision.create.mockResolvedValue({ id: "rev-2" })
    prisma.artifact.update.mockResolvedValue({ id: "art-1" })
    const result = await updateArtifact({
      artifactId: "art-1", workspaceId: "ws-1", title: " Updated prototype ",
      html: "<html><body>v2</body></html>", filename: "prototype.html",
    })
    expect(result.content[0].text).toContain("ID: art-1")
    expect(prisma.$transaction).toHaveBeenCalledTimes(1)
    expect(prisma.artifact.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ currentRevisionId: "rev-2", title: "Updated prototype" }),
    }))
  })
})

describe("Artifact MCP output redaction", () => {
  it("never returns private Blob pathnames", async () => {
    prisma.artifact.findUnique.mockResolvedValue({
      id: "art-1", workspaceId: "ws-1", title: "Prototype", sourceType: "HTML_UPLOAD", status: "ACTIVE",
      currentRevision: { id: "rev-1", revisionNumber: 1, blobPathname: "private/current.html" },
      revisions: [{ id: "rev-1", revisionNumber: 1, blobPathname: "private/rev.html" }],
      links: [],
    })
    const result = await getArtifact({ artifactId: "art-1" })
    expect(JSON.stringify(result)).not.toContain("private/")
    expect(JSON.stringify(result)).not.toContain("blobPathname")
  })
})
