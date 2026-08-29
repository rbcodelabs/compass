import { beforeEach, describe, expect, it, vi } from "vitest"

const prisma = {
  workspace: { findUnique: vi.fn() },
  artifact: { create: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn() },
  artifactRevision: { create: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), deleteMany: vi.fn() },
  artifactLink: { create: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), delete: vi.fn(), deleteMany: vi.fn() },
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
  beforeEach(() => vi.clearAllMocks())

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

  it("deletes workspace artifacts in DSQL-safe order and removes private blobs", async () => {
    prisma.artifact.findMany.mockResolvedValue([{ id: "art-1" }])
    prisma.artifactRevision.findMany.mockResolvedValue([{ blobPathname: "artifacts/ws-1/art-1/rev.html" }])
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
})
