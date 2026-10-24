/**
 * Worker-authenticated upload of an image the agent wants to show in the chat
 * (screenshots from the sandbox browser).
 *
 * Same trust model as `lib/agent-session-callback.ts`: bearer worker token
 * authenticated before the body is read, a streaming size cap that does not trust
 * content-length, and tenant scope taken from the run row — a worker can only ever
 * write into its own workspace. The bytes land in the same private store as doc
 * images, so the existing membership-gated read route serves them and the chat only
 * has to render a same-origin URL.
 *
 * The image type is decided by magic bytes, not by the caller's content-type: the
 * read route serves these under the declared extension, so a mislabelled payload
 * would otherwise be stored as something it is not.
 */

import getPrisma, { type AppPrismaClient } from "@/lib/db"
import { AgentRunError, authorizeAgentRunWorker } from "@/lib/agent-runs"
import { DOC_IMAGE_MAX_BYTES, createDocImage } from "@/lib/doc-images"
import { getArtifactStorage, type ArtifactStorage } from "@/lib/artifact-storage"

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i

const respond = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { "cache-control": "no-store" } })

/** Identify an image from its leading bytes. Returns null for anything we do not serve. */
export function sniffImageType(bytes: Uint8Array): "image/png" | "image/jpeg" | "image/gif" | "image/webp" | null {
  const at = (offset: number, ...expected: number[]) => expected.every((value, index) => bytes[offset + index] === value)
  if (bytes.byteLength >= 8 && at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png"
  if (bytes.byteLength >= 3 && at(0, 0xff, 0xd8, 0xff)) return "image/jpeg"
  if (bytes.byteLength >= 6 && at(0, 0x47, 0x49, 0x46, 0x38) && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) {
    return "image/gif"
  }
  if (bytes.byteLength >= 12 && at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp"
  return null
}

async function readImageBody(request: Request) {
  if (Number(request.headers.get("content-length")) > DOC_IMAGE_MAX_BYTES) {
    throw new AgentRunError("Image is too large", 413, "IMAGE_TOO_LARGE")
  }
  if (!request.body) throw new AgentRunError("Body is required", 400, "INVALID_CALLBACK_BODY")
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      total += chunk.value.byteLength
      if (total > DOC_IMAGE_MAX_BYTES) {
        await reader.cancel()
        throw new AgentRunError("Image is too large", 413, "IMAGE_TOO_LARGE")
      }
      chunks.push(chunk.value)
    }
    return new Uint8Array(Buffer.concat(chunks))
  } finally {
    reader.releaseLock()
  }
}

/** Strip anything path-like or control-ish; the name only ever labels alt text. */
function cleanFilename(raw: string | null): string {
  const base = (raw ?? "").split(/[\\/]/).pop() ?? ""
  const cleaned = base.replace(/[\u0000-\u001f\u007f[\]()<>]/g, "").trim().slice(0, 120)
  return cleaned || "screenshot"
}

export async function handleAgentImageUpload(
  request: Request,
  runId: string,
  database?: AppPrismaClient,
  storage?: () => Pick<ArtifactStorage, "put">,
) {
  try {
    if (!uuid.test(runId) || new URL(request.url).search) return respond({ error: "Invalid callback URL" }, 400)
    const bearer = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.get("authorization") ?? "")
    if (!bearer) return respond({ error: "Worker bearer token required" }, 401)
    const prisma = database ?? getPrisma()

    const run = await authorizeAgentRunWorker({ prisma, runId, rawToken: bearer[1] })
    if (run.kind !== "CHAT") return respond({ error: "This run does not show images", code: "IMAGES_NOT_SUPPORTED" }, 409)

    const bytes = await readImageBody(request)
    const fileType = sniffImageType(bytes)
    if (!fileType) return respond({ error: "Only PNG, JPEG, GIF and WebP images are supported", code: "UNSUPPORTED_IMAGE" }, 415)

    const filename = cleanFilename(request.headers.get("x-agent-image-name"))
    const image = await createDocImage(
      { workspaceId: run.workspaceId, filename, fileType, bytes },
      (storage ?? getArtifactStorage)(),
    )
    return respond({
      url: image.url,
      imageName: image.imageName,
      markdown: `![${filename}](${image.url})`,
      fileType: image.fileType,
      fileSize: image.fileSize,
    })
  } catch (error) {
    if (error instanceof AgentRunError) return respond({ error: error.message, code: error.code }, error.status)
    console.error("Agent image upload failed", { runId })
    return respond({ error: "Agent image upload failed" }, 500)
  }
}
