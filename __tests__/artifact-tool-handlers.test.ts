import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const storage = { put: vi.fn(), get: vi.fn(), del: vi.fn() }
const prisma = {
  workspace: { findUnique: vi.fn() },
  artifact: { findMany: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
  artifactRevision: { findFirst: vi.fn(), create: vi.fn() },
  artifactLink: { findFirst: vi.fn(), findMany: vi.fn() },
  solution: { findMany: vi.fn() },
  artifactBlobCleanup: { upsert: vi.fn() },
  $transaction: vi.fn(),
}

vi.mock("@/lib/db", () => ({ default: () => prisma }))
vi.mock("@/lib/artifact-storage", () => ({ getArtifactStorage: () => storage }))

import { getArtifact, listArtifacts, updateArtifact } from "@/lib/artifact-tool-handlers"

beforeEach(() => {
  vi.clearAllMocks()
  prisma.$transaction.mockImplementation(async (callback) => callback(prisma))
  prisma.artifactRevision.findFirst.mockResolvedValue(null)
  prisma.artifactLink.findMany.mockResolvedValue([])
  storage.put.mockResolvedValue({ pathname: "artifacts/ws-1/art-1/rev-2.html" })
  storage.del.mockResolvedValue(undefined)
})

describe("Artifact MCP update validation", () => {
  it("rejects html and url together before reading or writing", async () => {
    const result = await updateArtifact({
      artifactId: "art-1", workspaceId: "ws-1", html: "<html></html>", url: "https://example.com",
    })
    expect(result.content[0].text).toMatch(/only one of html, uploadReceipt or url/i)
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

describe("Artifact MCP user link", () => {
  const ORIGIN = "https://compass.example.test"
  const slugs = { slug: "compass", organization: { slug: "acme" } }
  const PAGE = `${ORIGIN}/acme/compass/docs/artifacts/art-1`

  beforeEach(() => {
    vi.stubEnv("VERCEL_ENV", "production")
    vi.stubEnv("NEXT_PUBLIC_APP_URL", ORIGIN)
    prisma.workspace.findUnique.mockResolvedValue(slugs)
  })
  afterEach(() => vi.unstubAllEnvs())

  it("get_artifact prints and returns the page URL", async () => {
    prisma.artifact.findUnique.mockResolvedValue({
      id: "art-1", workspaceId: "ws-1", title: "Prototype", sourceType: "HTML_UPLOAD", status: "ACTIVE",
      currentRevision: null, revisions: [], links: [],
    })
    const result = await getArtifact({ artifactId: "art-1" })
    expect(result.content[0].text).toContain(`URL: ${PAGE}`)
    expect(result.structuredContent).toMatchObject({ data: { url: PAGE } })
  })

  it("update_artifact prints and returns the page URL", async () => {
    prisma.artifact.findFirst.mockResolvedValue({ id: "art-1", sourceType: "HTML_UPLOAD" })
    prisma.artifact.update.mockResolvedValue({ id: "art-1" })
    const result = await updateArtifact({ artifactId: "art-1", workspaceId: "ws-1", title: "Renamed" })
    expect(result.content[0].text).toContain(`URL: ${PAGE}`)
    expect(result.structuredContent).toMatchObject({ data: { id: "art-1", url: PAGE } })
  })

  it("list_artifacts gives every item its own URL from one workspace lookup", async () => {
    prisma.artifact.findMany.mockResolvedValue([
      { id: "art-1", title: "One", kind: null },
      { id: "art-2", title: "Two", kind: null },
    ])
    const result = await listArtifacts({ workspaceId: "ws-1" })
    expect(result.content[0].text).toContain(`URL: ${PAGE}`)
    expect(result.content[0].text).toContain(`URL: ${ORIGIN}/acme/compass/docs/artifacts/art-2`)
    expect(result.structuredContent).toMatchObject({ data: { items: [{ url: PAGE }, { url: `${ORIGIN}/acme/compass/docs/artifacts/art-2` }] } })
    expect(prisma.workspace.findUnique).toHaveBeenCalledTimes(1)
  })

  it("omits the link rather than failing when the origin is not configured", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "")
    prisma.artifact.findFirst.mockResolvedValue({ id: "art-1", sourceType: "HTML_UPLOAD" })
    prisma.artifact.update.mockResolvedValue({ id: "art-1" })
    const result = await updateArtifact({ artifactId: "art-1", workspaceId: "ws-1", title: "Renamed" })
    expect(result.content[0].text).toBe("Artifact updated.\nID: art-1")
    expect(result.structuredContent).toMatchObject({ ok: true, data: { url: null } })
  })

  it("omits the link rather than failing when the workspace cannot be resolved", async () => {
    prisma.workspace.findUnique.mockResolvedValue(null)
    prisma.artifact.findFirst.mockResolvedValue({ id: "art-1", sourceType: "HTML_UPLOAD" })
    prisma.artifact.update.mockResolvedValue({ id: "art-1" })
    const result = await updateArtifact({ artifactId: "art-1", workspaceId: "ws-1", title: "Renamed" })
    expect(result.structuredContent).toMatchObject({ ok: true, data: { url: null } })
  })
})

describe("Artifact MCP kind", () => {
  it("switches an uploaded HTML Artifact to a slide deck without a new revision", async () => {
    prisma.artifact.findFirst.mockResolvedValue({ id: "art-1", sourceType: "HTML_UPLOAD" })
    prisma.artifact.update.mockResolvedValue({ id: "art-1" })
    await updateArtifact({ artifactId: "art-1", workspaceId: "ws-1", kind: "SLIDE_DECK" })
    expect(prisma.artifactRevision.create).not.toHaveBeenCalled()
    expect(prisma.artifact.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ kind: "SLIDE_DECK" }) }))
  })

  it("stores DOCUMENT as NULL", async () => {
    prisma.artifact.findFirst.mockResolvedValue({ id: "art-1", sourceType: "HTML_UPLOAD" })
    prisma.artifact.update.mockResolvedValue({ id: "art-1" })
    await updateArtifact({ artifactId: "art-1", workspaceId: "ws-1", kind: "DOCUMENT" })
    expect(prisma.artifact.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ kind: null }) }))
  })

  it("rejects a slide deck on an external link, and an unknown kind, without writing", async () => {
    prisma.artifact.findFirst.mockResolvedValue({ id: "art-1", sourceType: "EXTERNAL_LINK" })
    const external = await updateArtifact({ artifactId: "art-1", workspaceId: "ws-1", kind: "SLIDE_DECK" })
    expect(external.content[0].text).toMatch(/only html upload artifacts can be slide decks/i)
    const unknown = await updateArtifact({ artifactId: "art-1", workspaceId: "ws-1", kind: "CAROUSEL" })
    expect(unknown.content[0].text).toMatch(/kind must be DOCUMENT or SLIDE_DECK/)
    expect(prisma.artifact.update).not.toHaveBeenCalled()
  })

  it("returns kind and addressable slides for a slide deck", async () => {
    prisma.artifact.findUnique.mockResolvedValue({
      id: "art-1", workspaceId: "ws-1", title: "Deck", sourceType: "HTML_UPLOAD", kind: "SLIDE_DECK", status: "ACTIVE",
      currentRevision: { id: "rev-1", revisionNumber: 1, blobPathname: "private/current.html" },
      revisions: [{ id: "rev-1", revisionNumber: 1, blobPathname: "private/current.html" }],
      links: [],
    })
    storage.get.mockResolvedValue(new TextEncoder().encode('<html><body><section class="slide" data-slide-title="Intro">One</section><section class="slide">Two</section></body></html>'))
    const result = await getArtifact({ artifactId: "art-1" })
    expect(result.structuredContent).toMatchObject({ ok: true, data: { kind: "SLIDE_DECK", slides: [{ index: 0, title: "Intro" }, { index: 1 }] } })
    expect(result.content[0].text).toContain("Kind: SLIDE_DECK")
    expect(JSON.stringify(result)).not.toContain("private/")
  })
})
