import { describe, expect, it, vi } from "vitest"
import { readResearchChatStream, researchAttachmentMetadata } from "@/lib/research-chat-stream"

const final = { type: "final", result: { message: "Saved", turn: { id: "turn", role: "INTERVIEWER", content: "Saved", sequence: 2 }, replayed: false } }
function response(frames: unknown[]) {
  return new Response(frames.map((frame) => JSON.stringify(frame) + "\n").join(""))
}

describe("research provisional stream", () => {
  it.each(["image/gif", "image/heic"])("accepts saved %s metadata without allowing private paths", (mimeType) => {
    const metadata = { id: "attachment", originalName: "evidence", mimeType, sizeBytes: 24 }
    expect(researchAttachmentMetadata.parse(metadata)).toEqual(metadata)
    expect(researchAttachmentMetadata.safeParse({ ...metadata, blobPathname: "private/path" }).success).toBe(false)
  })
  it("returns only committed final and delivers provisional text separately", async () => {
    const onDelta = vi.fn()
    expect(await readResearchChatStream(response([{ type: "delta", text: "Draft" }, final]), onDelta)).toEqual(final.result)
    expect(onDelta).toHaveBeenCalledWith("Draft")
  })
  it.each([
    [{ type: "delta", text: "Unfinished" }],
    [{ type: "delta", text: "Draft" }, { type: "error", status: 502 }],
    [final, { type: "error", status: 502 }],
    [final, final],
    [{ type: "delta", text: "x".repeat(4001) }, final],
    [{ type: "private", secret: "never accepted" }, final],
  ])("fails closed on incomplete, failed or malformed frames %#", async (...frames) => {
    await expect(readResearchChatStream(response(frames), vi.fn())).rejects.toThrow()
  })
  it("decodes split UTF-8 and split JSON lines", async () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ type: "delta", text: "é" }) + "\n" + JSON.stringify(final) + "\n")
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      for (const byte of bytes) controller.enqueue(new Uint8Array([byte]))
      controller.close()
    } })
    const delta = vi.fn()
    expect(await readResearchChatStream(new Response(stream), delta)).toEqual(final.result)
    expect(delta).toHaveBeenCalledWith("é")
  })
})
