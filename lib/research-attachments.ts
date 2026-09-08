import { createHash, randomBytes } from "node:crypto"

export const MAX_RESEARCH_ATTACHMENT_BYTES = 10 * 1024 * 1024
export const MAX_RESEARCH_ATTACHMENTS_PER_SESSION = 20
export const MAX_RESEARCH_ATTACHMENT_BYTES_PER_SESSION = 50 * 1024 * 1024

type ApprovedAttachment = {
  kind: "SCREENSHOT" | "DOCUMENT"
  extension: "png" | "jpg" | "webp" | "gif" | "heic" | "pdf"
}

function startsWith(bytes: Uint8Array, signature: number[]) {
  return signature.every((value, index) => bytes[index] === value)
}

function detectedType(bytes: Uint8Array): ApprovedAttachment | null {
  const header = String.fromCharCode(...bytes.slice(0, 6))
  if ((header === "GIF87a" || header === "GIF89a") && bytes.length >= 14 &&
    (bytes[6] || bytes[7]) && (bytes[8] || bytes[9]) && bytes.at(-1) === 0x3b) return { kind: "SCREENSHOT", extension: "gif" }
  if (bytes.length >= 16 && String.fromCharCode(...bytes.slice(4, 8)) === "ftyp") {
    const boxSize = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0)
    // Recognize bounded still-image HEIC brands, never generic HEIF/AVIF/video.
    // This is a container signature check, not a decoder or validity guarantee.
    if (boxSize >= 16 && boxSize <= Math.min(bytes.length, 4096) && boxSize % 4 === 0) {
      const brands = [String.fromCharCode(...bytes.slice(8, 12))]
      for (let offset = 16; offset < boxSize; offset += 4) brands.push(String.fromCharCode(...bytes.slice(offset, offset + 4)))
      if (["heic", "heix", "mif1"].includes(brands[0]) && brands.some((brand) => brand === "heic" || brand === "heix")) return { kind: "SCREENSHOT", extension: "heic" }
    }
    return null
  }
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { kind: "SCREENSHOT", extension: "png" }
  }
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return { kind: "SCREENSHOT", extension: "jpg" }
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    String.fromCharCode(...bytes.slice(8, 12)) === "WEBP"
  ) return { kind: "SCREENSHOT", extension: "webp" }
  if (String.fromCharCode(...bytes.slice(0, 5)) === "%PDF-") {
    return { kind: "DOCUMENT", extension: "pdf" }
  }
  return null
}

const MIME_BY_EXTENSION: Record<ApprovedAttachment["extension"], string[]> = {
  png: ["image/png"],
  jpg: ["image/jpeg"],
  webp: ["image/webp"],
  gif: ["image/gif"],
  heic: ["image/heic"],
  pdf: ["application/pdf"],
}

export function validateResearchAttachmentUpload({
  bytes,
  mimeType,
  originalName,
}: {
  bytes: Uint8Array
  mimeType: string
  originalName: string
}) {
  if (bytes.length === 0) throw new Error("Attachment cannot be empty")
  if (bytes.length > MAX_RESEARCH_ATTACHMENT_BYTES) throw new Error("Attachment exceeds 10 MiB")
  const name = originalName.trim()
  if (!name || name.length > 255 || name.includes("/") || name.includes("\\") || name === "." || name === "..") {
    throw new Error("Attachment filename is invalid")
  }
  const detected = detectedType(bytes)
  const providedMimeType = mimeType.toLowerCase()
  const unspecifiedMimeType = !providedMimeType || providedMimeType === "application/octet-stream"
  const nativeHeicWithoutSpecificMime = unspecifiedMimeType && /\.heic$/i.test(name) && detected?.extension === "heic"
  if (unspecifiedMimeType && !nativeHeicWithoutSpecificMime) {
    throw new Error("This browser did not identify the file type. Try another browser or share a PNG, JPEG or PDF instead.")
  }
  const normalizedMimeType = nativeHeicWithoutSpecificMime ? "image/heic" : providedMimeType
  if (!detected || !MIME_BY_EXTENSION[detected.extension].includes(normalizedMimeType)) {
    throw new Error("Attachment type or signature is not supported")
  }
  return {
    ...detected,
    originalName: name,
    mimeType: MIME_BY_EXTENSION[detected.extension][0],
    sizeBytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  }
}

function safeSegment(value: string) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error("Invalid attachment path segment")
  return value
}

export function buildResearchAttachmentPathname({
  workspaceId,
  studyId,
  sessionId,
  attachmentId,
  extension,
}: {
  workspaceId: string
  studyId: string
  sessionId: string
  attachmentId: string
  extension: ApprovedAttachment["extension"]
}) {
  return [
    "research",
    safeSegment(workspaceId),
    safeSegment(studyId),
    safeSegment(sessionId),
    `${safeSegment(attachmentId)}-${randomBytes(16).toString("hex")}.${extension}`,
  ].join("/")
}
