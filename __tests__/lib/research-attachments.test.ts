import { describe, expect, it } from "vitest"
import {
  MAX_RESEARCH_ATTACHMENT_BYTES,
  buildResearchAttachmentPathname,
  validateResearchAttachmentUpload,
} from "@/lib/research-attachments"

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1])
const pdf = new TextEncoder().encode("%PDF-1.7\ncontent")

function heicBytes() {
  const bytes = new Uint8Array(24)
  new DataView(bytes.buffer).setUint32(0, 24)
  bytes.set(new TextEncoder().encode("ftypheic"), 4)
  bytes.set(new TextEncoder().encode("mif1heic"), 16)
  return bytes
}

describe("research attachment validation", () => {
  it("accepts a native HEIC file when the browser omits its MIME type", () => {
    expect(validateResearchAttachmentUpload({ bytes: heicBytes(), mimeType: "", originalName: "photo.HEIC" }))
      .toMatchObject({ extension: "heic", mimeType: "image/heic" })
  })

  it("rejects missing MIME unless both the filename and bounded signature identify HEIC", () => {
    expect(() => validateResearchAttachmentUpload({ bytes: heicBytes(), mimeType: "", originalName: "photo.jpg" })).toThrow(/file type/)
    expect(() => validateResearchAttachmentUpload({ bytes: png, mimeType: "", originalName: "photo.heic" })).toThrow(/file type/)
  })
  it.each(["GIF87a", "GIF89a"])("accepts the %s signature as a private GIF original", (signature) => {
    const bytes = new TextEncoder().encode(signature + "\u0001\u0000\u0001\u0000\u0000\u0000\u0000;")
    expect(validateResearchAttachmentUpload({ bytes, mimeType: "image/gif", originalName: "screen.gif" })).toMatchObject({ extension: "gif", mimeType: "image/gif" })
  })
  it("recognizes a bounded HEIC-specific ftyp brand, not generic HEIF or AVIF", () => {
    const bytes = heicBytes()
    expect(validateResearchAttachmentUpload({ bytes, mimeType: "image/heic", originalName: "photo.heic" })).toMatchObject({ extension: "heic", mimeType: "image/heic" })
    for (const major of ["mif1", "avif", "isom"]) {
      const wrong = bytes.slice(); wrong.set(new TextEncoder().encode(major), 8); wrong.set(new TextEncoder().encode("mif1avif"), 16)
      expect(() => validateResearchAttachmentUpload({ bytes: wrong, mimeType: "image/heic", originalName: "fake.heic" })).toThrow()
    }
    const truncated = bytes.slice(); new DataView(truncated.buffer).setUint32(0, 128)
    expect(() => validateResearchAttachmentUpload({ bytes: truncated, mimeType: "image/heic", originalName: "cut.heic" })).toThrow()
    expect(() => validateResearchAttachmentUpload({ bytes, mimeType: "image/jpeg", originalName: "fake.jpg" })).toThrow()
  })
  it("accepts matching bounded image and PDF signatures", () => {
    expect(validateResearchAttachmentUpload({ bytes: png, mimeType: "image/png", originalName: "screen.png" }))
      .toMatchObject({ kind: "SCREENSHOT", extension: "png", sizeBytes: png.length, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) })
    expect(validateResearchAttachmentUpload({ bytes: pdf, mimeType: "application/pdf", originalName: "notes.pdf" }))
      .toMatchObject({ kind: "DOCUMENT", extension: "pdf" })
  })

  it.each(["avif", "isom", "hevc"])("rejects a %s primary container even with a claimed HEIC compatible brand", (brand) => {
    const bytes = new Uint8Array(20)
    new DataView(bytes.buffer).setUint32(0, 20)
    bytes.set(new TextEncoder().encode(`ftyp${brand}`), 4)
    bytes.set(new TextEncoder().encode("heic"), 16)
    expect(() => validateResearchAttachmentUpload({ bytes, mimeType: "image/heic", originalName: "other.heic" })).toThrow()
  })

  it.each([0, 1, 12, 18, 4097])("rejects unsupported or malformed HEIC box size %s", (size) => {
    const bytes = new Uint8Array(24)
    new DataView(bytes.buffer).setUint32(0, size)
    bytes.set(new TextEncoder().encode("ftypheic"), 4)
    expect(() => validateResearchAttachmentUpload({ bytes, mimeType: "image/heic", originalName: "bad.heic" })).toThrow()
  })

  it.each([
    { bytes: new Uint8Array(), mimeType: "image/png", originalName: "empty.png" },
    { bytes: pdf, mimeType: "image/png", originalName: "spoofed.png" },
    { bytes: png, mimeType: "text/html", originalName: "screen.html" },
    { bytes: png, mimeType: "image/png", originalName: "../screen.png" },
    { bytes: new Uint8Array(MAX_RESEARCH_ATTACHMENT_BYTES + 1), mimeType: "image/png", originalName: "large.png" },
  ])("rejects empty, spoofed, unsupported, unsafe, or oversized input", (input) => {
    expect(() => validateResearchAttachmentUpload(input)).toThrow()
  })

  it("builds an unguessable tenant-scoped private pathname without the original name", () => {
    const pathname = buildResearchAttachmentPathname({
      workspaceId: "workspace-1",
      studyId: "study-1",
      sessionId: "session-1",
      attachmentId: "attachment-1",
      extension: "png",
    })
    expect(pathname).toMatch(/^research\/workspace-1\/study-1\/session-1\/attachment-1-[a-f0-9]{32}\.png$/)
    expect(pathname).not.toContain("screen")
  })
})
