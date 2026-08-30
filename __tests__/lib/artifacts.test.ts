import { beforeEach, describe, expect, it, vi } from "vitest"

const prisma = {
  workspace: { findUnique: vi.fn() },
  artifact: { create: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn(), delete: vi.fn(), deleteMany: vi.fn() },
  artifactRevision: { create: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), deleteMany: vi.fn() },
  artifactLink: { create: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), delete: vi.fn(), deleteMany: vi.fn() },
  artifactBlobCleanup: { upsert: vi.fn(), findMany: vi.fn(), update: vi.fn(), delete: vi.fn() },
  solution: { findFirst: vi.fn(), findMany: vi.fn() },
  $transaction: vi.fn(),
}

vi.mock("@/lib/db", () => ({ default: () => prisma }))

import {
  MAX_ARTIFACT_HTML_BYTES,
  buildSandboxedHtml,
  createExternalArtifact,
  createHtmlArtifact,
  deleteWorkspaceArtifacts,
  linkArtifactToSolution,
  replaceHtmlArtifactRevision,
  replaceExternalArtifactRevision,
  toArtifactDetailDto,
  validateExternalUrl,
  validateHtmlUpload,
} from "@/lib/artifacts"

describe("artifact validation", () => {
  it("accepts a self-contained HTML document", () => {
    const body = new TextEncoder().encode("<!doctype html><html><body>Prototype</body></html>")
    expect(validateHtmlUpload({ filename: "prototype.html", mimeType: "text/html", bytes: body })).toEqual({
      ok: true,
    })
  })

  it.each([
    ["prototype.zip", "text/html", "<html></html>", "filename"],
    ["prototype.html", "application/zip", "<html></html>", "MIME"],
    ["prototype.html", "text/html", "not html", "content"],
  ])("rejects invalid upload %s", (filename, mimeType, content, reason) => {
    const result = validateHtmlUpload({
      filename,
      mimeType,
      bytes: new TextEncoder().encode(content),
    })
    expect(result).toEqual(expect.objectContaining({ ok: false }))
    if (!result.ok) expect(result.error).toMatch(new RegExp(reason, "i"))
  })

  it("rejects HTML above the explicit size cap", () => {
    const result = validateHtmlUpload({
      filename: "prototype.html",
      mimeType: "text/html",
      bytes: new Uint8Array(MAX_ARTIFACT_HTML_BYTES + 1),
    })
    expect(result).toEqual(expect.objectContaining({ ok: false }))
  })

  it("accepts only external http and https URLs", () => {
    expect(validateExternalUrl("https://example.com/prototype")).toBe("https://example.com/prototype")
    expect(() => validateExternalUrl("file:///etc/passwd")).toThrow(/http/i)
    expect(() => validateExternalUrl("javascript:alert(1)")).toThrow(/http/i)
    expect(() => validateExternalUrl("https://user:secret@example.com/prototype")).toThrow(/credentials/i)
  })

  it.each(["../prototype.html", "folder/prototype.html", "prototype\u0000.html"])(
    "rejects unsafe upload filename %s",
    (filename) => {
      const result = validateHtmlUpload({
        filename,
        mimeType: "text/html",
        bytes: new TextEncoder().encode("<html><body>Prototype</body></html>"),
      })
      expect(result).toEqual(expect.objectContaining({ ok: false }))
    }
  )

  it("rejects invalid UTF-8 anywhere in the uploaded document", () => {
    const prefix = new TextEncoder().encode(`<html><body>${"a".repeat(5000)}`)
    const bytes = new Uint8Array(prefix.length + 2)
    bytes.set(prefix)
    bytes.set([0xc3, 0x28], prefix.length)
    expect(validateHtmlUpload({ filename: "prototype.html", mimeType: "text/html", bytes })).toEqual(
      expect.objectContaining({ ok: false })
    )
  })

  it("prepends a restrictive CSP and never grants same-origin", () => {
    const uploaded = "<html><script>document.body.textContent='ok'</script></html>"
    const html = buildSandboxedHtml(uploaded)
    expect(html.endsWith(uploaded)).toBe(true)
    expect(html).toContain("default-src 'none'")
    expect(html).toContain("connect-src 'none'")
    expect(html).toContain("form-action 'none'")
    expect(html).not.toContain("allow-same-origin")
  })
})

describe("artifact lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    prisma.$transaction.mockImplementation(async (callback) => callback(prisma))
    prisma.artifactBlobCleanup.findMany.mockResolvedValue([])
    prisma.artifactRevision.findFirst.mockResolvedValue(null)
  })

  it("creates uploaded HTML with a private storage write and immutable revision", async () => {
    prisma.workspace.findUnique.mockResolvedValue({ id: "ws-1" })
    prisma.artifact.create.mockResolvedValue({ id: "art-1" })
    prisma.artifactRevision.create.mockResolvedValue({ id: "rev-1" })
    prisma.artifact.update.mockResolvedValue({ id: "art-1" })
    const storage = { put: vi.fn().mockResolvedValue({ pathname: "artifacts/ws-1/art-1/rev-1.html" }), get: vi.fn(), del: vi.fn() }

    const result = await createHtmlArtifact({
      workspaceId: "ws-1",
      title: "Checkout prototype",
      filename: "checkout.html",
      mimeType: "text/html",
      bytes: new TextEncoder().encode("<html><body>Checkout</body></html>"),
      createdById: "user-1",
      source: "UI",
    }, storage)

    expect(storage.put).toHaveBeenCalledWith(expect.stringContaining("artifacts/ws-1/"), expect.any(Uint8Array))
    expect(prisma.artifactRevision.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ artifactId: "art-1", revisionNumber: 1 }),
    }))
    expect(prisma.artifact.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ currentRevisionId: "rev-1" }),
    }))
    expect(result.id).toBe("art-1")
  })

  it("does not fetch an external URL while creating an external artifact", async () => {
    prisma.workspace.findUnique.mockResolvedValue({ id: "ws-1" })
    prisma.artifact.create.mockResolvedValue({ id: "art-2" })
    prisma.artifactRevision.create.mockResolvedValue({ id: "rev-2" })
    prisma.artifact.update.mockResolvedValue({ id: "art-2" })
    const fetchSpy = vi.spyOn(globalThis, "fetch")
    await createExternalArtifact({ workspaceId: "ws-1", title: "Live prototype", url: "https://example.com", source: "MCP" })
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it("rejects whitespace-only titles before writing", async () => {
    prisma.workspace.findUnique.mockResolvedValue({ id: "ws-1" })
    await expect(createExternalArtifact({ workspaceId: "ws-1", title: "   ", url: "https://example.com", source: "MCP" }))
      .rejects.toThrow(/title/i)
    expect(prisma.artifact.create).not.toHaveBeenCalled()
  })

  it("uses one transaction so external creation rolls back when the current pointer fails", async () => {
    prisma.workspace.findUnique.mockResolvedValue({ id: "ws-1" })
    prisma.artifact.create.mockResolvedValue({ id: "art-2" })
    prisma.artifactRevision.create.mockResolvedValue({ id: "rev-2" })
    prisma.artifact.update.mockRejectedValue(new Error("pointer failed"))
    await expect(createExternalArtifact({ workspaceId: "ws-1", title: "Prototype", url: "https://example.com", source: "MCP" }))
      .rejects.toThrow("pointer failed")
    expect(prisma.$transaction).toHaveBeenCalledTimes(1)
    expect(prisma.artifact.delete).not.toHaveBeenCalled()
  })

  it("deletes an uploaded Blob when transactional HTML creation fails", async () => {
    prisma.workspace.findUnique.mockResolvedValue({ id: "ws-1" })
    prisma.artifact.create.mockResolvedValue({ id: "art-1" })
    prisma.artifactRevision.create.mockResolvedValue({ id: "rev-1" })
    prisma.artifact.update.mockRejectedValue(new Error("pointer failed"))
    const storage = { put: vi.fn().mockResolvedValue({ pathname: "artifacts/ws-1/rev-1.html" }), get: vi.fn(), del: vi.fn().mockResolvedValue(undefined) }
    await expect(createHtmlArtifact({
      workspaceId: "ws-1", title: "Prototype", filename: "prototype.html", mimeType: "text/html",
      bytes: new TextEncoder().encode("<html></html>"), source: "UI",
    }, storage)).rejects.toThrow("pointer failed")
    expect(storage.del).toHaveBeenCalledWith("artifacts/ws-1/rev-1.html")
  })

  it("queues failed-write Blob cleanup when compensation cannot reach storage", async () => {
    prisma.workspace.findUnique.mockResolvedValue({ id: "ws-1" })
    prisma.artifact.create.mockResolvedValue({ id: "art-1" })
    prisma.artifactRevision.create.mockResolvedValue({ id: "rev-1" })
    prisma.artifact.update.mockRejectedValue(new Error("pointer failed"))
    const storage = { put: vi.fn().mockResolvedValue({ pathname: "artifacts/ws-1/rev-orphan.html" }), get: vi.fn(), del: vi.fn().mockRejectedValue(new Error("Blob unavailable")) }
    await expect(createHtmlArtifact({
      workspaceId: "ws-1", title: "Prototype", filename: "prototype.html", mimeType: "text/html",
      bytes: new TextEncoder().encode("<html></html>"), source: "UI",
    }, storage)).rejects.toThrow("pointer failed")
    expect(prisma.artifactBlobCleanup.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { blobPathname: "artifacts/ws-1/rev-orphan.html" },
      create: expect.objectContaining({ reason: "FAILED_WRITE" }),
    }))
  })

  it("deletes an uploaded Blob when transactional revision replacement fails", async () => {
    prisma.artifact.findFirst.mockResolvedValue({ id: "art-1" })
    prisma.artifactRevision.findFirst.mockResolvedValue({ revisionNumber: 1 })
    prisma.artifactRevision.create.mockResolvedValue({ id: "rev-2" })
    prisma.artifact.update.mockRejectedValue(new Error("pointer failed"))
    const storage = { put: vi.fn().mockResolvedValue({ pathname: "artifacts/ws-1/rev-2.html" }), get: vi.fn(), del: vi.fn().mockResolvedValue(undefined) }
    await expect(replaceHtmlArtifactRevision({
      artifactId: "art-1", workspaceId: "ws-1", filename: "prototype.html", mimeType: "text/html",
      bytes: new TextEncoder().encode("<html></html>"), source: "MCP",
    }, storage)).rejects.toThrow("pointer failed")
    expect(prisma.$transaction).toHaveBeenCalledTimes(1)
    expect(storage.del).toHaveBeenCalledWith("artifacts/ws-1/rev-2.html")
  })

  it("rolls back an external revision when advancing the current pointer fails", async () => {
    prisma.artifact.findFirst.mockResolvedValue({ id: "art-1" })
    prisma.artifactRevision.create.mockResolvedValue({ id: "rev-2" })
    prisma.artifact.update.mockRejectedValue(new Error("pointer failed"))
    await expect(replaceExternalArtifactRevision({
      artifactId: "art-1", workspaceId: "ws-1", url: "https://example.com/v2", source: "MCP",
    })).rejects.toThrow("pointer failed")
    expect(prisma.$transaction).toHaveBeenCalledTimes(1)
  })

  it("rejects cross-workspace solution links", async () => {
    prisma.artifact.findFirst.mockResolvedValue({ id: "art-1", workspaceId: "ws-1" })
    prisma.solution.findFirst.mockResolvedValue(null)
    await expect(linkArtifactToSolution({ artifactId: "art-1", solutionId: "sol-2", workspaceId: "ws-1" }))
      .rejects.toThrow(/same workspace/i)
    expect(prisma.artifactLink.create).not.toHaveBeenCalled()
  })

  it("returns the existing link for duplicate link requests", async () => {
    prisma.artifact.findFirst.mockResolvedValue({ id: "art-1", workspaceId: "ws-1" })
    prisma.solution.findFirst.mockResolvedValue({ id: "sol-1" })
    prisma.artifactLink.findFirst.mockResolvedValue({ id: "link-1", artifactId: "art-1", linkedId: "sol-1" })
    const result = await linkArtifactToSolution({ artifactId: "art-1", solutionId: "sol-1", workspaceId: "ws-1" })
    expect(result).toEqual(expect.objectContaining({ id: "link-1", created: false }))
    expect(prisma.artifactLink.create).not.toHaveBeenCalled()
  })

  it("returns the winning link when concurrent creation hits the unique constraint", async () => {
    prisma.artifact.findFirst.mockResolvedValue({ id: "art-1", workspaceId: "ws-1" })
    prisma.solution.findFirst.mockResolvedValue({ id: "sol-1" })
    prisma.artifactLink.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "link-winner" })
    prisma.artifactLink.create.mockRejectedValue(Object.assign(new Error("unique"), { code: "P2002" }))
    await expect(linkArtifactToSolution({ artifactId: "art-1", solutionId: "sol-1", workspaceId: "ws-1" }))
      .resolves.toEqual(expect.objectContaining({ id: "link-winner", created: false }))
  })

  it("deletes workspace artifacts in DSQL-safe order and removes private blobs", async () => {
    prisma.artifact.findMany.mockResolvedValue([{ id: "art-1" }])
    prisma.artifactRevision.findMany.mockResolvedValue([{ blobPathname: "artifacts/ws-1/art-1/rev.html" }])
    prisma.artifactBlobCleanup.findMany.mockResolvedValue([{ id: "cleanup-1", blobPathname: "artifacts/ws-1/art-1/rev.html", attempts: 0 }])
    const storage = { put: vi.fn(), get: vi.fn(), del: vi.fn().mockResolvedValue(undefined) }
    await deleteWorkspaceArtifacts(prisma, "ws-1", storage)
    expect(prisma.artifactLink.deleteMany).toHaveBeenCalledWith({ where: { workspaceId: "ws-1" } })
    expect(prisma.artifact.updateMany).toHaveBeenCalledWith({ where: { workspaceId: "ws-1" }, data: { currentRevisionId: null, updatedAt: expect.any(Date) } })
    expect(prisma.artifactRevision.deleteMany).toHaveBeenCalledWith({ where: { artifactId: { in: ["art-1"] } } })
    expect(prisma.artifact.deleteMany).toHaveBeenCalledWith({ where: { workspaceId: "ws-1" } })
    expect(storage.del).toHaveBeenCalledWith("artifacts/ws-1/art-1/rev.html")
    expect(prisma.artifactLink.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(prisma.artifactRevision.deleteMany.mock.invocationCallOrder[0])
    expect(prisma.artifactRevision.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(prisma.artifact.deleteMany.mock.invocationCallOrder[0])
  })

  it("retains a durable Blob cleanup row when storage deletion fails", async () => {
    prisma.artifact.findMany.mockResolvedValue([{ id: "art-1" }])
    prisma.artifactRevision.findMany.mockResolvedValue([{ blobPathname: "artifacts/ws-1/rev.html" }])
    prisma.artifactBlobCleanup.findMany.mockResolvedValue([{ id: "cleanup-1", blobPathname: "artifacts/ws-1/rev.html", attempts: 0 }])
    const storage = { put: vi.fn(), get: vi.fn(), del: vi.fn().mockRejectedValue(new Error("Blob unavailable")) }
    await deleteWorkspaceArtifacts(prisma, "ws-1", storage)
    expect(prisma.artifactBlobCleanup.upsert.mock.invocationCallOrder[0]).toBeLessThan(prisma.artifactRevision.deleteMany.mock.invocationCallOrder[0])
    expect(prisma.artifactBlobCleanup.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "cleanup-1" }, data: expect.objectContaining({ attempts: 1 }),
    }))
    expect(prisma.artifactBlobCleanup.delete).not.toHaveBeenCalled()
  })

  it("safe-maps the Artifact detail DTO without private Blob pathnames", () => {
    const dto = toArtifactDetailDto({
      id: "art-1", title: "Prototype", description: null, sourceType: "HTML_UPLOAD", status: "ACTIVE",
      currentRevision: { externalUrl: null, blobPathname: "private/current.html" },
      revisions: [{ id: "rev-1", revisionNumber: 1, filename: "prototype.html", byteSize: 10, externalUrl: null, blobPathname: "private/rev.html", createdAt: new Date("2026-08-29T00:00:00Z") }],
    })
    expect(JSON.stringify(dto)).not.toContain("blobPathname")
    expect(JSON.stringify(dto)).not.toContain("private/")
  })
})
