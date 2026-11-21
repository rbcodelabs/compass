// @vitest-environment jsdom
//
// TASK-195 S3: the client opener that turns an old `?comment=<id>` link into the Conversation panel.
import React from "react"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const nav = vi.hoisted(() => ({ search: "", pathname: "/acme/core/discovery/OPP-3", replace: vi.fn(), push: vi.fn() }))
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: nav.replace, push: nav.push }),
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(nav.search),
}))
vi.mock("@/components/panels/conversation-panel", () => ({ useConversationPanelOptional: () => ({ workspaceId: "ws-1" }) }))

import { CommentDeepLinkOpener } from "@/components/panels/comment-deep-link-opener"

const CID = "5d2a7e14-3b9c-4f60-8a21-c7e9d0f4b312"
const MID = "9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d"
const located = { conversationId: CID, messageId: MID, isRoot: false, targetType: "OPPORTUNITY", targetId: "t", status: "OPEN", archived: false }

let fetchMock: ReturnType<typeof vi.fn>
function reply(status: number, body?: unknown) {
  // A fresh Response per call: the same one cannot be read twice (strict mode runs the lookup twice).
  fetchMock.mockImplementation(async () => (status === 200 ? Response.json(body) : new Response("Not found", { status })))
}
const locateCalls = () => fetchMock.mock.calls.map(([url]) => String(url)).filter((url) => url.includes("/conversations/locate"))

beforeEach(() => {
  vi.resetAllMocks()
  nav.search = `?comment=${MID}`
  nav.pathname = "/acme/core/discovery/OPP-3"
  window.history.replaceState(null, "", "/acme/core/discovery/OPP-3")
  fetchMock = vi.fn()
  vi.stubGlobal("fetch", fetchMock)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("CommentDeepLinkOpener", () => {
  it("asks the locate route for the workspace and message, then replaces (not pushes) the URL once", async () => {
    reply(200, located)
    render(<CommentDeepLinkOpener />)
    await waitFor(() => expect(nav.replace).toHaveBeenCalledTimes(1))
    expect(locateCalls()).toEqual([`/api/agent/conversations/locate?workspaceId=ws-1&messageId=${MID}`])
    const href = new URL(nav.replace.mock.calls[0]![0] as string, "https://x.test")
    expect(href.pathname).toBe("/acme/core/discovery/OPP-3")
    expect(href.searchParams.get("detail")).toBe(`conversation:${CID}`)
    expect(href.searchParams.get("comment")).toBe(MID)
    expect(nav.push).not.toHaveBeenCalled()
  })

  it("keeps other params and the hash", async () => {
    nav.search = `?foo=bar&rail=help&comment=${MID}`
    window.history.replaceState(null, "", `/acme/core/discovery/OPP-3${nav.search}#lane`)
    reply(200, located)
    render(<CommentDeepLinkOpener />)
    await waitFor(() => expect(nav.replace).toHaveBeenCalled())
    const href = new URL(nav.replace.mock.calls[0]![0] as string, "https://x.test")
    expect(href.searchParams.get("foo")).toBe("bar")
    expect(href.searchParams.get("rail")).toBe("help")
    expect(href.hash).toBe("#lane")
  })

  it("does not loop: once the URL is canonical it neither locates nor rewrites again", async () => {
    reply(200, located)
    const view = render(<CommentDeepLinkOpener />)
    await waitFor(() => expect(nav.replace).toHaveBeenCalledTimes(1))
    nav.search = `?detail=${encodeURIComponent(`conversation:${CID}`)}&comment=${MID}`
    view.rerender(<CommentDeepLinkOpener />)
    view.rerender(<CommentDeepLinkOpener />)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(locateCalls()).toHaveLength(1)
    expect(nav.replace).toHaveBeenCalledTimes(1)
  })

  it("checks a cold canonical URL (reload, shared link) once and rewrites nothing when it already matches", async () => {
    nav.search = `?detail=${encodeURIComponent(`conversation:${CID}`)}&comment=${MID}`
    reply(200, located)
    render(<CommentDeepLinkOpener />)
    await waitFor(() => expect(locateCalls()).toHaveLength(1))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(nav.replace).not.toHaveBeenCalled()
  })

  it("moves the panel to the right thread when a ?comment link is followed while another conversation is open", async () => {
    const OTHER = "11111111-2222-4333-8444-555555555555"
    nav.search = `?detail=${encodeURIComponent(`conversation:${OTHER}`)}&comment=${MID}`
    reply(200, located)
    render(<CommentDeepLinkOpener />)
    await waitFor(() => expect(nav.replace).toHaveBeenCalledTimes(1))
    const href = new URL(nav.replace.mock.calls[0]![0] as string, "https://x.test")
    expect(href.searchParams.get("detail")).toBe(`conversation:${CID}`)
    expect(href.searchParams.get("comment")).toBe(MID)
  })

  it("leaves another open panel alone", async () => {
    nav.search = `?detail=${encodeURIComponent("task:abc")}&comment=${MID}`
    render(<CommentDeepLinkOpener />)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(nav.replace).not.toHaveBeenCalled()
  })

  it("never reopens a thread for a comment param left behind by another panel, even after that panel closes", async () => {
    nav.search = `?detail=${encodeURIComponent("task:abc")}&comment=${MID}`
    const view = render(<CommentDeepLinkOpener />)
    nav.search = `?comment=${MID}`
    view.rerender(<CommentDeepLinkOpener />)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(nav.replace).not.toHaveBeenCalled()
  })

  it("defers to the legacy rail redirect: with rc in the URL it does nothing, then proceeds once rc is gone", async () => {
    nav.search = `?rc=${CID}&comment=${MID}`
    reply(200, located)
    const view = render(<CommentDeepLinkOpener />)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(nav.replace).not.toHaveBeenCalled()
    nav.search = `?comment=${MID}`
    view.rerender(<CommentDeepLinkOpener />)
    await waitFor(() => expect(nav.replace).toHaveBeenCalledTimes(1))
    expect(new URL(nav.replace.mock.calls[0]![0] as string, "https://x.test").searchParams.has("rc")).toBe(false)
  })

  it("makes no lookup on a Docs route (document comments belong to the Docs sidebar)", async () => {
    nav.pathname = "/acme/core/docs/DOC-1"
    render(<CommentDeepLinkOpener />)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(nav.replace).not.toHaveBeenCalled()
  })

  it("does nothing without a comment param", async () => {
    nav.search = "?foo=bar"
    render(<CommentDeepLinkOpener />)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(nav.replace).not.toHaveBeenCalled()
  })

  it("leaves a document comment to the Docs sidebar: no rewrite, no notice", async () => {
    reply(200, { ...located, targetType: "DOC" })
    render(<CommentDeepLinkOpener />)
    await waitFor(() => expect(locateCalls()).toHaveLength(1))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(nav.replace).not.toHaveBeenCalled()
    expect(screen.queryByRole("status")).toBeNull()
  })

  it("shows a neutral note and drops the param for an unknown or inaccessible id (no error banner)", async () => {
    reply(404)
    nav.search = `?foo=bar&comment=${MID}`
    render(<CommentDeepLinkOpener />)
    await waitFor(() => expect(nav.replace).toHaveBeenCalledTimes(1))
    expect(nav.replace.mock.calls[0]![0]).toBe("/acme/core/discovery/OPP-3?foo=bar")
    const note = screen.getByRole("status")
    expect(note).toHaveTextContent(/isn.t available/i)
    expect(screen.queryByRole("alert")).toBeNull()
    // The note says nothing that distinguishes deleted from forbidden.
    expect(note.textContent).not.toMatch(/deleted|forbidden|permission|denied|not found/i)
  })

  it("treats a malformed id like an unknown one without calling the server", async () => {
    nav.search = "?comment=OPP-3"
    render(<CommentDeepLinkOpener />)
    await waitFor(() => expect(nav.replace).toHaveBeenCalledTimes(1))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(nav.replace.mock.calls[0]![0]).toBe("/acme/core/discovery/OPP-3")
    expect(screen.getByRole("status")).toBeInTheDocument()
  })

  it("leaves the URL and the page alone when the lookup itself fails (offline, 500), then retries and opens", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      fetchMock.mockRejectedValueOnce(new Error("offline"))
      fetchMock.mockImplementation(async () => Response.json(located))
      render(<CommentDeepLinkOpener />)
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
      expect(nav.replace).not.toHaveBeenCalled()
      expect(screen.queryByRole("alert")).toBeNull()
      await vi.advanceTimersByTimeAsync(3500)
      await waitFor(() => expect(nav.replace).toHaveBeenCalledTimes(1))
      expect(fetchMock).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it("treats a 500 like a transient failure: no note, no URL change", async () => {
    reply(500)
    render(<CommentDeepLinkOpener />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(nav.replace).not.toHaveBeenCalled()
    expect(screen.queryByRole("status")).toBeNull()
  })

  it("after the panel is closed (detail removed, comment kept) drops the stale comment param instead of reopening it", async () => {
    reply(200, located)
    const view = render(<CommentDeepLinkOpener />)
    await waitFor(() => expect(nav.replace).toHaveBeenCalledTimes(1))
    nav.search = `?detail=${encodeURIComponent(`conversation:${CID}`)}&comment=${MID}`
    view.rerender(<CommentDeepLinkOpener />)
    nav.search = `?comment=${MID}`
    view.rerender(<CommentDeepLinkOpener />)
    await waitFor(() => expect(nav.replace).toHaveBeenCalledTimes(2))
    expect(nav.replace.mock.calls[1]![0]).toBe("/acme/core/discovery/OPP-3")
    expect(locateCalls()).toHaveLength(1)
  })

  it("survives React strict mode's double effect (the first lookup is aborted, the second completes)", async () => {
    reply(200, located)
    render(
      <React.StrictMode>
        <CommentDeepLinkOpener />
      </React.StrictMode>,
    )
    await waitFor(() => expect(nav.replace).toHaveBeenCalled())
    expect(new Set(nav.replace.mock.calls.map(([href]) => href)).size).toBe(1)
  })
})
