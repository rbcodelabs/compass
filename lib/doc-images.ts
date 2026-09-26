import { randomUUID } from "node:crypto"
import { generateClientTokenFromReadWriteToken } from "@vercel/blob/client"
import type { ArtifactStorage } from "@/lib/artifact-storage"

export const DOC_IMAGE_MAX_BYTES = 10 * 1024 * 1024
export const DOC_IMAGE_ALLOWED_MIME_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const
type DocImageMimeType = (typeof DOC_IMAGE_ALLOWED_MIME_TYPES)[number]

const EXTENSION_BY_MIME: Record<DocImageMimeType, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp",
}
const MIME_BY_EXTENSION = Object.fromEntries(Object.entries(EXTENSION_BY_MIME).map(([mime, extension]) => [extension, mime])) as Record<string, DocImageMimeType>
const IMAGE_NAME_PATTERN = /^([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.(png|jpg|gif|webp)$/i
const DIRECT_UPLOAD_TTL_MS = 10 * 60 * 1000

function validateImageInput(input: { filename: string; fileType: string; fileSize: number }): DocImageMimeType {
  if (!input.filename || input.filename.length > 255) throw new Error("Image filenames must be between 1 and 255 characters.")
  if (!(input.fileType in EXTENSION_BY_MIME)) throw new Error(`Unsupported image type: ${input.fileType}`)
  if (!Number.isInteger(input.fileSize) || input.fileSize < 1) throw new Error("The image is empty.")
  if (input.fileSize > DOC_IMAGE_MAX_BYTES) throw new Error("Images must be 10 MiB or smaller.")
  return input.fileType as DocImageMimeType
}

function createIdentity(workspaceId: string, fileType: DocImageMimeType) {
  const imageId = randomUUID()
  const imageName = `${imageId}.${EXTENSION_BY_MIME[fileType]}`
  return { imageId, imageName, pathname: `docs/${workspaceId}/images/${imageName}`, url: buildDocImageReadUrl(workspaceId, imageName) }
}

export function buildDocImageReadUrl(workspaceId: string, imageName: string): string {
  return `/api/docs/images/${encodeURIComponent(workspaceId)}/${encodeURIComponent(imageName)}`
}

export function resolveDocImage(workspaceId: string, imageName: string): { pathname: string; fileType: DocImageMimeType } | null {
  const match = IMAGE_NAME_PATTERN.exec(imageName)
  if (!match) return null
  const extension = match[2].toLowerCase()
  return { pathname: `docs/${workspaceId}/images/${match[1].toLowerCase()}.${extension}`, fileType: MIME_BY_EXTENSION[extension] }
}

export async function createDocImage(input: { workspaceId: string; filename: string; fileType: string; bytes: Uint8Array }, storage: Pick<ArtifactStorage, "put">) {
  const fileType = validateImageInput({ ...input, fileSize: input.bytes.byteLength })
  const identity = createIdentity(input.workspaceId, fileType)
  await storage.put(identity.pathname, input.bytes, fileType)
  return { ...identity, fileType, fileSize: input.bytes.byteLength, filename: input.filename }
}

export async function prepareDocImageUpload(input: { workspaceId: string; filename: string; fileType: string; fileSize: number }, now = Date.now()) {
  const fileType = validateImageInput(input)
  const token = process.env.ARTIFACT_BLOB_READ_WRITE_TOKEN?.trim()
  if (!token) throw new Error("Private artifact storage is not configured")
  const identity = createIdentity(input.workspaceId, fileType)
  const expiresAt = now + DIRECT_UPLOAD_TTL_MS
  const clientToken = await generateClientTokenFromReadWriteToken({ token, pathname: identity.pathname, allowedContentTypes: [fileType], maximumSizeInBytes: input.fileSize, validUntil: expiresAt, addRandomSuffix: false, allowOverwrite: false })
  return { ...identity, filename: input.filename, fileType, fileSize: input.fileSize, clientToken, expiresAt, access: "private" as const, markdown: `![${input.filename}](${identity.url})` }
}
