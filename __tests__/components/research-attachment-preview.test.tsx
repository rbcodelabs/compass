// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ResearchAttachmentPreview } from "@/components/research/research-attachment-preview"

const attachment = { id: "attachment-1", originalName: "evidence.pdf", mimeType: "application/pdf" as const, sizeBytes: 3 }
const props = { attachment, token: "opaque-study", sessionId: "session-1", resumeToken: "opaque-resume" }
describe("private participant previews", () => {
  beforeEach(() => { URL.createObjectURL = vi.fn().mockReturnValue("blob:authorized"); URL.revokeObjectURL = vi.fn() })
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })
  it("uses an authorized POST and an ephemeral PDF link, not a public blob URL", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("pdf", { headers: { "Content-Type": "application/pdf" } })))
    render(<ResearchAttachmentPreview {...props} />)
    expect(await screen.findByRole("link", { name: "evidence.pdf" })).toHaveAttribute("href", "blob:authorized")
    expect(fetch).toHaveBeenCalledWith("/api/research/attachments/attachment-1", expect.objectContaining({
      method: "POST", body: JSON.stringify({ token: props.token, sessionId: props.sessionId, resumeToken: props.resumeToken }),
    }))
    cleanup()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:authorized")
  })
  it.each([
    [403, "application/pdf", "pdf"], [200, "text/html", "pdf"],
    [200, "application/pdf", "oversized"], [200, "application/pdf", "p"],
  ])("does not expose an unauthorized, mismatched or incomplete payload %#", async (status, mime, body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { status, headers: { "Content-Type": mime } })))
    render(<ResearchAttachmentPreview {...props} />)
    expect(await screen.findByText("Preview unavailable")).toBeVisible()
    expect(URL.createObjectURL).not.toHaveBeenCalled()
    expect(screen.queryByRole("link")).not.toBeInTheDocument()
  })
  it("does not create a URL after unmount while an authorized download is pending", async () => {
    let resolve!: (response: Response) => void
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => new Promise<Response>((done) => { resolve = done })))
    const view = render(<ResearchAttachmentPreview {...props} />)
    view.unmount()
    resolve(new Response("pdf", { headers: { "Content-Type": "application/pdf" } }))
    await waitFor(() => expect(vi.mocked(fetch).mock.calls[0][1]?.signal?.aborted).toBe(true))
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })
})
