import { beforeEach, describe, expect, it, vi } from "vitest"

const storage = { put: vi.fn(), get: vi.fn(), del: vi.fn() }
const prisma = {
  workspace: { findUnique: vi.fn() },
  artifact: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
  artifactRevision: { findFirst: vi.fn(), create: vi.fn() },
  artifactBlobCleanup: { upsert: vi.fn(), findMany: vi.fn() },
  $transaction: vi.fn(),
}
const generateClientToken = vi.fn()

vi.mock("@/lib/db", () => ({ default: () => prisma }))
vi.mock("@/lib/artifact-storage", () => ({ getArtifactStorage: () => storage }))
vi.mock("@vercel/blob/client", () => ({ generateClientTokenFromReadWriteToken: (...args: unknown[]) => generateClientToken(...args) }))

import { createArtifact, prepareArtifactUploadTool, updateArtifact } from "@/lib/artifact-tool-handlers"
import { prepareArtifactUpload, verifyArtifactUploadReceipt } from "@/lib/artifact-upload"

const WS = "11111111-1111-4111-8111-111111111111"
const OTHER_WS = "22222222-2222-4222-8222-222222222222"
const HTML = "<!doctype html><html><body>hello</body></html>"
const htmlBytes = new TextEncoder().encode(HTML)
const text = (result: { content: { text: string }[] }) => result.content[0].text

beforeEach(() => {
  vi.clearAllMocks()
  process.env.ARTIFACT_BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_test_token"
  delete process.env.ARTIFACT_UPLOAD_RECEIPT_SECRET
  generateClientToken.mockResolvedValue("client-token")
  prisma.workspace.findUnique.mockResolvedValue({ id: WS })
  prisma.$transaction.mockImplementation(async (callback) => callback(prisma))
  prisma.artifactBlobCleanup.findMany.mockResolvedValue([])
  prisma.artifactRevision.findFirst.mockResolvedValue(null)
  prisma.artifact.create.mockImplementation(async ({ data }) => ({ ...data }))
  prisma.artifactRevision.create.mockResolvedValue({ id: "rev-1" })
  prisma.artifact.update.mockResolvedValue({})
  storage.put.mockImplementation(async (pathname: string) => ({ pathname }))
  storage.del.mockResolvedValue(undefined)
})

describe("prepareArtifactUpload", () => {
  it("mints a workspace-prefixed staging path and a token bound to text/html and the exact size", async () => {
    const prepared = await prepareArtifactUpload({ workspaceId: WS, filename: "proto.html", fileSize: htmlBytes.byteLength })
    expect(prepared.pathname).toBe(`artifact-staging/${WS}/${prepared.uploadId}.html`)
    expect(generateClientToken).toHaveBeenCalledWith(expect.objectContaining({
      pathname: prepared.pathname, allowedContentTypes: ["text/html"], maximumSizeInBytes: htmlBytes.byteLength, allowOverwrite: false, addRandomSuffix: false,
    }))
    expect(verifyArtifactUploadReceipt(prepared.receipt, WS)).toMatchObject({ workspaceId: WS, filename: "proto.html", fileSize: htmlBytes.byteLength })
  })

  it.each([
    [{ filename: "proto.txt", fileSize: 10 }, /end in \.html/],
    [{ filename: "../x.html", fileSize: 10 }, /safe single filename/],
    [{ filename: "a.html", fileSize: 0 }, /empty/],
    [{ filename: "a.html", fileSize: 2 * 1024 * 1024 + 1 }, /2 MB/],
  ])("rejects invalid request %j", async (input, message) => {
    await expect(prepareArtifactUpload({ workspaceId: WS, ...input })).rejects.toThrow(message)
  })

  it("fails closed when private storage is not configured", async () => {
    delete process.env.ARTIFACT_BLOB_READ_WRITE_TOKEN
    await expect(prepareArtifactUpload({ workspaceId: WS, filename: "a.html", fileSize: 10 })).rejects.toThrow(/not configured/i)
  })

  it("returns a failure (not a throw) for an unknown workspace", async () => {
    prisma.workspace.findUnique.mockResolvedValue(null)
    expect(text(await prepareArtifactUploadTool({ workspaceId: WS, filename: "a.html", fileSize: 10 }))).toMatch(/No workspace found/)
  })
})

describe("verifyArtifactUploadReceipt", () => {
  async function receipt() {
    return (await prepareArtifactUpload({ workspaceId: WS, filename: "a.html", fileSize: 10 })).receipt
  }

  it("rejects a receipt used in a different workspace", async () => {
    const r = await receipt()
    expect(() => verifyArtifactUploadReceipt(r, OTHER_WS)).toThrow(/does not belong/)
  })

  it("rejects a tampered payload", async () => {
    const [, signature] = (await receipt()).split(".")
    const forged = Buffer.from(JSON.stringify({ version: 1, uploadId: "x", workspaceId: WS, pathname: `artifact-staging/${WS}/x.html`, filename: "a.html", fileSize: 10, expiresAt: Date.now() + 1e6 })).toString("base64url")
    expect(() => verifyArtifactUploadReceipt(`${forged}.${signature}`, WS)).toThrow(/Invalid upload receipt/)
  })

  it("rejects an expired receipt", async () => {
    const prepared = await prepareArtifactUpload({ workspaceId: WS, filename: "a.html", fileSize: 10 }, Date.now() - 11 * 60 * 1000)
    expect(() => verifyArtifactUploadReceipt(prepared.receipt, WS)).toThrow(/expired/)
  })

  it("does not accept a receipt signed under a different secret", async () => {
    const r = await receipt()
    process.env.ARTIFACT_BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_other_token"
    expect(() => verifyArtifactUploadReceipt(r, WS)).toThrow(/Invalid upload receipt/)
  })

  it("rejects malformed receipts", () => {
    expect(() => verifyArtifactUploadReceipt("nope", WS)).toThrow(/Invalid upload receipt/)
    expect(() => verifyArtifactUploadReceipt("a.b.c", WS)).toThrow(/Invalid upload receipt/)
  })
})

describe("createArtifact with uploadReceipt", () => {
  async function stagedReceipt(bytes = htmlBytes, filename = "proto.html") {
    const prepared = await prepareArtifactUpload({ workspaceId: WS, filename, fileSize: bytes.byteLength })
    storage.get.mockResolvedValue(bytes)
    return prepared
  }

  it("creates the artifact from the staged blob and deletes the staging copy", async () => {
    const prepared = await stagedReceipt()
    const result = await createArtifact({ workspaceId: WS, title: "Proto", sourceType: "HTML_UPLOAD", uploadReceipt: prepared.receipt })
    expect(text(result)).toMatch(/Artifact created/)
    expect(storage.get).toHaveBeenCalledWith(prepared.pathname)
    expect(storage.put).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`^artifacts/${WS}/.*proto\\.html$`)), htmlBytes)
    expect(storage.del).toHaveBeenCalledWith(prepared.pathname)
  })

  it("rejects html together with uploadReceipt, and neither", async () => {
    const prepared = await stagedReceipt()
    expect(text(await createArtifact({ workspaceId: WS, title: "P", sourceType: "HTML_UPLOAD", html: HTML, uploadReceipt: prepared.receipt }))).toMatch(/exactly one of html or uploadReceipt/)
    expect(text(await createArtifact({ workspaceId: WS, title: "P", sourceType: "HTML_UPLOAD" }))).toMatch(/exactly one of html or uploadReceipt/)
    expect(storage.put).not.toHaveBeenCalled()
  })

  it("rejects a conflicting filename and EXTERNAL_LINK + uploadReceipt", async () => {
    const prepared = await stagedReceipt()
    expect(text(await createArtifact({ workspaceId: WS, title: "P", sourceType: "HTML_UPLOAD", uploadReceipt: prepared.receipt, filename: "other.html" }))).toMatch(/filename is fixed/)
    expect(text(await createArtifact({ workspaceId: WS, title: "P", sourceType: "EXTERNAL_LINK", url: "https://example.com", uploadReceipt: prepared.receipt }))).toMatch(/does not accept/)
  })

  it("refuses a receipt minted for another workspace", async () => {
    const prepared = await stagedReceipt()
    const result = await createArtifact({ workspaceId: OTHER_WS, title: "P", sourceType: "HTML_UPLOAD", uploadReceipt: prepared.receipt })
    expect(text(result)).toMatch(/does not belong to this workspace/)
    expect(storage.get).not.toHaveBeenCalled()
    expect(storage.put).not.toHaveBeenCalled()
  })

  it("fails clearly when nothing was uploaded or it was already consumed", async () => {
    const prepared = await stagedReceipt()
    storage.get.mockResolvedValue(null)
    const result = await createArtifact({ workspaceId: WS, title: "P", sourceType: "HTML_UPLOAD", uploadReceipt: prepared.receipt })
    expect(text(result)).toMatch(/No uploaded file found/)
    expect(storage.put).not.toHaveBeenCalled()
  })

  it("rejects an uploaded file whose size differs from the signed size", async () => {
    const prepared = await stagedReceipt()
    storage.get.mockResolvedValue(new TextEncoder().encode(`${HTML}<!-- extra -->`))
    expect(text(await createArtifact({ workspaceId: WS, title: "P", sourceType: "HTML_UPLOAD", uploadReceipt: prepared.receipt }))).toMatch(/size does not match/)
    expect(storage.put).not.toHaveBeenCalled()
  })

  it("still applies HTML validation to uploaded bytes and keeps the staging blob", async () => {
    const notHtml = new TextEncoder().encode("just some text, not a document")
    const prepared = await stagedReceipt(notHtml)
    const result = await createArtifact({ workspaceId: WS, title: "P", sourceType: "HTML_UPLOAD", uploadReceipt: prepared.receipt })
    expect(text(result)).toMatch(/complete HTML document/)
    expect(storage.put).not.toHaveBeenCalled()
    expect(storage.del).not.toHaveBeenCalledWith(prepared.pathname)
  })

  it("still accepts inline html", async () => {
    expect(text(await createArtifact({ workspaceId: WS, title: "P", sourceType: "HTML_UPLOAD", html: HTML }))).toMatch(/Artifact created/)
    expect(storage.get).not.toHaveBeenCalled()
  })
})

describe("updateArtifact with uploadReceipt", () => {
  it("creates a new revision from the staged blob and discards it", async () => {
    prisma.artifact.findFirst.mockResolvedValue({ id: "art-1", sourceType: "HTML_UPLOAD" })
    const prepared = await prepareArtifactUpload({ workspaceId: WS, filename: "v2.html", fileSize: htmlBytes.byteLength })
    storage.get.mockResolvedValue(htmlBytes)
    const result = await updateArtifact({ artifactId: "art-1", workspaceId: WS, uploadReceipt: prepared.receipt })
    expect(text(result)).toMatch(/Artifact updated/)
    expect(storage.put).toHaveBeenCalledWith(expect.stringMatching(/v2\.html$/), htmlBytes)
    expect(storage.del).toHaveBeenCalledWith(prepared.pathname)
  })

  it("rejects uploadReceipt on an EXTERNAL_LINK artifact and mixed inputs", async () => {
    prisma.artifact.findFirst.mockResolvedValue({ id: "art-1", sourceType: "EXTERNAL_LINK" })
    const prepared = await prepareArtifactUpload({ workspaceId: WS, filename: "v2.html", fileSize: htmlBytes.byteLength })
    expect(text(await updateArtifact({ artifactId: "art-1", workspaceId: WS, uploadReceipt: prepared.receipt }))).toMatch(/accept url revisions/)
    expect(text(await updateArtifact({ artifactId: "art-1", workspaceId: WS, uploadReceipt: prepared.receipt, html: HTML }))).toMatch(/only one of/i)
    expect(storage.get).not.toHaveBeenCalled()
  })
})
