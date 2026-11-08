// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { DocPublishControl, PUBLISH_INFO_COPY, portalDocUrl } from "@/components/docs/doc-publish-control"
import { dismissUndoToast, getUndoToasts } from "@/lib/ui/undo-toast"

const base = { docId: "00000000-0000-4000-8000-000000000001", orgSlug: "acme", workspaceSlug: "main", publishable: true, canPublish: true }
const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal("fetch", fetchMock)
})
afterEach(() => {
  cleanup()
  for (const toast of getUndoToasts()) dismissUndoToast(toast.id)
  vi.unstubAllGlobals()
})

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })

describe("DocPublishControl", () => {
  it("shows the neutral state and no copy button when unpublished", () => {
    render(<DocPublishControl {...base} initialPublishedAt={null} />)
    expect(screen.getByTestId("doc-publish-badge").textContent).toContain("Not published")
    expect(screen.queryByRole("button", { name: /copy public link/i })).toBeNull()
    expect(screen.getByRole("switch", { name: "Publish to portal" }).getAttribute("aria-checked")).toBe("false")
  })

  it("publishes optimistically, shows the green badge and copy button, and posts the right body", async () => {
    let resolve!: (r: Response) => void
    fetchMock.mockReturnValue(new Promise<Response>((r) => (resolve = r)))
    render(<DocPublishControl {...base} initialPublishedAt={null} />)
    fireEvent.click(screen.getByRole("switch", { name: "Publish to portal" }))
    // Optimistic: flipped before the server answers.
    expect(screen.getByTestId("doc-publish-badge").textContent).toContain("Published to portal")
    expect(fetchMock).toHaveBeenCalledWith(`/api/docs/${base.docId}/publish`, expect.objectContaining({ method: "POST", body: JSON.stringify({ published: true }) }))
    resolve(json(200, { id: base.docId, published: true, publishedAt: "2026-11-06T00:00:00.000Z" }))
    await waitFor(() => expect(screen.getByRole("button", { name: /copy public link/i })).toBeTruthy())
  })

  it("rolls back and toasts the error when the server rejects", async () => {
    fetchMock.mockResolvedValue(json(404, { error: "Workspace not found" }))
    render(<DocPublishControl {...base} initialPublishedAt={null} />)
    fireEvent.click(screen.getByRole("switch", { name: "Publish to portal" }))
    await waitFor(() => expect(screen.getByTestId("doc-publish-badge").textContent).toContain("Not published"))
    expect(getUndoToasts().some((t) => t.message.includes("Workspace not found"))).toBe(true)
  })

  it("rolls back when the network fails", async () => {
    fetchMock.mockRejectedValue(new TypeError("offline"))
    render(<DocPublishControl {...base} initialPublishedAt="2026-11-04T00:00:00.000Z" />)
    fireEvent.click(screen.getByRole("switch", { name: "Publish to portal" }))
    await waitFor(() => expect(getUndoToasts().length).toBeGreaterThan(0))
    expect(screen.getByTestId("doc-publish-badge").textContent).toContain("Published to portal")
  })

  it("copies the absolute portal URL and confirms with a toast", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true })
    render(<DocPublishControl {...base} initialPublishedAt="2026-11-04T00:00:00.000Z" />)
    fireEvent.click(screen.getByRole("button", { name: /copy public link/i }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(portalDocUrl(window.location.origin, "acme", "main", base.docId)))
    expect(writeText.mock.calls[0][0]).toMatch(/^https?:\/\/.+\/portal\/acme\/main\/docs\/00000000-0000-4000-8000-000000000001$/)
    expect(getUndoToasts().some((t) => t.message === "Public link copied")).toBe(true)
  })

  it("exposes the exact info copy", () => {
    expect(PUBLISH_INFO_COPY).toBe("Visible to anyone with the portal link. Unpublishing removes it immediately.")
    render(<DocPublishControl {...base} initialPublishedAt={null} />)
    fireEvent.click(screen.getByRole("button", { name: "About publishing" }))
    return waitFor(() => expect(screen.getByText(PUBLISH_INFO_COPY)).toBeTruthy())
  })

  it("is disabled, without calling the API, for unpublishable docs and read-only members", () => {
    for (const props of [{ publishable: false, canPublish: true }, { publishable: true, canPublish: false }]) {
      const { unmount } = render(<DocPublishControl {...base} {...props} initialPublishedAt={null} />)
      const sw = screen.getByRole("switch", { name: "Publish to portal" })
      expect(sw.hasAttribute("disabled") || sw.getAttribute("aria-disabled") === "true" || sw.hasAttribute("data-disabled")).toBe(true)
      fireEvent.click(sw)
      expect(fetchMock).not.toHaveBeenCalled()
      unmount()
    }
  })
})
