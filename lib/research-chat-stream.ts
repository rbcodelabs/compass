import { z } from "zod"

export class ResearchChatResponseError extends Error {
  constructor(readonly status: number) {
    super(status === 503 ? "The interviewer is unavailable. Please let the research team know and try again later."
      : status >= 500 ? "The interviewer service couldn’t complete the reply. Try again; if it keeps failing, contact the research team."
      : status === 429 ? "Please wait a moment before trying again. The interviewer is receiving too many requests."
      : status === 409 ? "The session couldn’t accept this reply yet. Wait a moment and retry; if it keeps failing, contact the research team."
      : "The session couldn’t accept this reply. Please contact the research team.")
    this.name = "ResearchChatResponseError"
  }
}

export const researchAttachmentMetadata = z.object({
  id: z.string().min(1).max(128), originalName: z.string().min(1).max(255),
  mimeType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif", "image/heic", "application/pdf"]),
  sizeBytes: z.number().int().min(1).max(10 * 1024 * 1024),
}).strict()
export type ResearchChatAttachment = z.infer<typeof researchAttachmentMetadata>
const turn = z.object({ id: z.string().min(1).max(128), role: z.literal("INTERVIEWER"), content: z.string().min(1).max(4000), sequence: z.number().int().min(0) }).strict()
const result = z.object({ message: z.string().trim().min(1).max(4000), turn, replayed: z.boolean() }).strict()
export function parseResearchChatReply(value: unknown) {
  const committed = result.parse(value)
  if (committed.message !== committed.turn.content) throw new Error("Committed reply mismatch")
  return committed
}
const frame = z.discriminatedUnion("type", [
  z.object({ type: z.literal("delta"), text: z.string().max(4000) }).strict(),
  z.object({ type: z.literal("final"), result }).strict(),
  z.object({ type: z.literal("error"), status: z.number().int().min(400).max(599) }).strict(),
])

export async function readResearchChatStream(response: Response, onDelta: (text: string) => void) {
  if (!response.body) throw new Error("Reply stream is missing")
  const reader = response.body.getReader()
  const decoder = new TextDecoder("utf-8", { fatal: true })
  let buffer = "", chars = 0, bytes = 0
  let committed: z.infer<typeof result> | null = null
  function consume(line: string) {
    const event = frame.parse(JSON.parse(line))
    if (committed) throw new Error("Reply stream failed")
    if (event.type === "error") throw new ResearchChatResponseError(event.status)
    if (event.type === "final") {
      committed = parseResearchChatReply(event.result)
    } else {
      chars += event.text.length
      if (chars > 4000) throw new Error("Reply stream exceeded limit")
      onDelta(event.text)
    }
  }
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > 128 * 1024) throw new Error("Reply stream exceeded limit")
      buffer += decoder.decode(chunk.value, { stream: true })
      let newline: number
      while ((newline = buffer.indexOf("\n")) !== -1) {
        consume(buffer.slice(0, newline))
        buffer = buffer.slice(newline + 1)
      }
      if (buffer.length > 64 * 1024) throw new Error("Reply frame exceeded limit")
    }
    buffer += decoder.decode()
    if (buffer || !committed) throw new Error("Reply stream was interrupted before confirmation")
    return committed as z.infer<typeof result>
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    throw error
  } finally { reader.releaseLock() }
}
