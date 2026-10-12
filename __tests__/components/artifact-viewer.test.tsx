// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

type PreviewProps = {
  pickMode?: boolean
  onElementPicked?: (picked: { selector: string | null; fingerprint: Record<string, unknown> }) => void
  onAnchorsResolved?: (resolutions: Record<string, unknown>) => void
  resolutions?: Record<string, { status: string }>
  renderPin?: (commentId: string, resolution: { status: string }) => React.ReactNode
}

// The sandboxed iframe's own message-protocol mechanics are covered by
// __tests__/artifact-preview.test.tsx; this file exercises ArtifactViewer's
// own state machine (pick → compose → post → pin refresh) by driving
// ArtifactPreview's props directly through a thin capturing stub.
let latestProps: PreviewProps = {}
vi.mock("@/components/docs/artifact-preview", () => ({
  ArtifactPreview: (props: PreviewProps) => {
    latestProps = props
    return (
      <div data-testid="preview-stub" data-pick-mode={props.pickMode ? "true" : "false"}>
        {Object.entries(props.resolutions ?? {}).map(([commentId, resolution]) =>
          resolution.status === "anchored" ? <div key={commentId}>{props.renderPin?.(commentId, resolution)}</div> : null,
        )}
      </div>
    )
  },
}))

import { ArtifactViewer } from "@/components/docs/artifact-viewer"

const fetchMock = vi.fn()
beforeEach(() => {
  latestProps = {}
  fetchMock.mockReset().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ items: [] }), { status: 200 })))
  vi.stubGlobal("fetch", fetchMock)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const props = { title: "Prototype", html: "<html></html>", artifactId: "artifact-1" }

it("fetches anchored comments on mount to seed pins", async () => {
  render(<ArtifactViewer {...props} />)
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/comments?targetType=ARTIFACT&targetId=artifact-1"))
})

it("toggles pick mode via the Leave feedback button", async () => {
  render(<ArtifactViewer {...props} />)
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
  fireEvent.click(screen.getByRole("button", { name: "Leave feedback" }))
  expect(screen.getByTestId("preview-stub")).toHaveAttribute("data-pick-mode", "true")
  expect(screen.getByRole("status")).toHaveTextContent(/click an element/i)
  fireEvent.click(screen.getByRole("button", { name: "Cancel picking" }))
  expect(screen.getByTestId("preview-stub")).toHaveAttribute("data-pick-mode", "false")
})

it("opens a composer after a pick, posts the anchor, and clears the draft", async () => {
  render(<ArtifactViewer {...props} />)
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
  fireEvent.click(screen.getByRole("button", { name: "Leave feedback" }))

  act(() => {
    latestProps.onElementPicked?.({ selector: "button.cta", fingerprint: { tag: "button", text: "Buy now" } })
  })
  expect(screen.getByText(/commenting on: button/i)).toBeInTheDocument()
  // Picking closes pick mode automatically — the click already happened.
  expect(screen.getByTestId("preview-stub")).toHaveAttribute("data-pick-mode", "false")

  fetchMock.mockImplementationOnce(() => Promise.resolve(new Response(JSON.stringify({ id: "comment-1" }), { status: 201 })))
  fireEvent.change(screen.getByRole("textbox", { name: "Anchored feedback" }), { target: { value: "Move this button up" } })
  fireEvent.click(screen.getByRole("button", { name: "Post feedback" }))

  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3)) // initial GET + POST + refresh GET
  const postCall = fetchMock.mock.calls.find(([, init]) => init?.method === "POST")
  expect(postCall?.[0]).toBe("/api/comments")
  const body = JSON.parse(postCall![1].body as string)
  expect(body).toMatchObject({
    targetType: "ARTIFACT",
    targetId: "artifact-1",
    body: "Move this button up",
    elementAnchor: { elementSelector: "button.cta", elementFingerprint: { tag: "button", text: "Buy now" } },
  })
  expect(typeof body.elementAnchor.pageUrl).toBe("string")
  expect(typeof body.elementAnchor.pagePath).toBe("string")
  expect(screen.queryByRole("textbox", { name: "Anchored feedback" })).not.toBeInTheDocument()
})

it("shows a post error and keeps the draft when the API rejects the comment", async () => {
  render(<ArtifactViewer {...props} />)
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
  fireEvent.click(screen.getByRole("button", { name: "Leave feedback" }))
  act(() => {
    latestProps.onElementPicked?.({ selector: null, fingerprint: { tag: "div" } })
  })
  fetchMock.mockImplementationOnce(() => Promise.resolve(new Response(JSON.stringify({ error: "Workspace membership required." }), { status: 403 })))
  fireEvent.change(screen.getByRole("textbox", { name: "Anchored feedback" }), { target: { value: "Broken layout" } })
  fireEvent.click(screen.getByRole("button", { name: "Post feedback" }))
  expect(await screen.findByRole("alert")).toHaveTextContent("Workspace membership required.")
  expect(screen.getByRole("textbox", { name: "Anchored feedback" })).toHaveValue("Broken layout")
})

it("surfaces a stale-anchor count without rendering a pin for it", async () => {
  render(<ArtifactViewer {...props} />)
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
  act(() => {
    latestProps.onAnchorsResolved?.({ c1: { status: "stale" }, c2: { status: "anchored" } })
  })
  expect(screen.getByText(/1 pinned comment could not be re-anchored/i)).toBeInTheDocument()
})

it("opens the full comment when a pin is clicked, and closes it again", async () => {
  fetchMock.mockImplementation(() => Promise.resolve(new Response(JSON.stringify({
    items: [{ id: "c1", authorName: "Dana", body: "Move this button above the fold.", elementAnchor: { elementSelector: "button.cta", elementFingerprint: { tag: "button" } } }],
  }), { status: 200 })))
  render(<ArtifactViewer {...props} />)
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
  act(() => {
    latestProps.onAnchorsResolved?.({ c1: { status: "anchored", confidence: 1, geometry: { left: 10, top: 20, width: 80, height: 30 } } })
  })
  const pin = await screen.findByRole("button", { name: /Feedback from Dana/ })
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument()

  fireEvent.click(pin)
  expect(screen.getByRole("dialog", { name: "Feedback from Dana" })).toHaveTextContent("Move this button above the fold.")

  fireEvent.click(screen.getByRole("button", { name: "Close feedback" }))
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
})

it("posts a threaded reply from the pin card and shows it in place", async () => {
  fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      return Promise.resolve(new Response(JSON.stringify({ id: "r1", authorName: "Sam", body: "Done, moved it." }), { status: 201 }))
    }
    return Promise.resolve(new Response(JSON.stringify({
      items: [{
        id: "c1", authorName: "Dana", body: "Move this button above the fold.",
        replies: [{ id: "r0", authorName: "Lee", body: "Agreed." }],
        elementAnchor: { elementSelector: "button.cta", elementFingerprint: { tag: "button" } },
      }],
    }), { status: 200 }))
  })
  const onFeedbackPosted = vi.fn()
  render(<ArtifactViewer {...props} onFeedbackPosted={onFeedbackPosted} />)
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
  act(() => {
    latestProps.onAnchorsResolved?.({ c1: { status: "anchored", confidence: 1, geometry: { left: 10, top: 20, width: 80, height: 30 } } })
  })
  fireEvent.click(await screen.findByRole("button", { name: /Feedback from Dana/ }))
  expect(screen.getByRole("dialog")).toHaveTextContent("Agreed.")

  fireEvent.change(screen.getByRole("textbox", { name: "Reply to Dana" }), { target: { value: "Done, moved it." } })
  fireEvent.click(screen.getByRole("button", { name: "Post reply" }))

  await waitFor(() => expect(screen.getByRole("dialog")).toHaveTextContent("Sam"))
  const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST")!
  expect(JSON.parse(post[1].body as string)).toEqual({ targetType: "ARTIFACT", targetId: "artifact-1", parentId: "c1", body: "Done, moved it." })
  expect(screen.getByRole("textbox", { name: "Reply to Dana" })).toHaveValue("")
  expect(onFeedbackPosted).toHaveBeenCalledTimes(1)
})

it("keeps the reply draft and shows the error when a reply is rejected", async () => {
  fetchMock.mockImplementation((_url: string, init?: RequestInit) => init?.method === "POST"
    ? Promise.resolve(new Response(JSON.stringify({ error: "Workspace membership required." }), { status: 403 }))
    : Promise.resolve(new Response(JSON.stringify({
      items: [{ id: "c1", authorName: "Dana", body: "Hi", elementAnchor: { elementSelector: "a", elementFingerprint: { tag: "a" } } }],
    }), { status: 200 })))
  render(<ArtifactViewer {...props} />)
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
  act(() => {
    latestProps.onAnchorsResolved?.({ c1: { status: "anchored", confidence: 1, geometry: { left: 1, top: 1, width: 1, height: 1 } } })
  })
  fireEvent.click(await screen.findByRole("button", { name: /Feedback from Dana/ }))
  fireEvent.change(screen.getByRole("textbox", { name: "Reply to Dana" }), { target: { value: "No access" } })
  fireEvent.click(screen.getByRole("button", { name: "Post reply" }))
  expect(await screen.findByRole("alert")).toHaveTextContent("Workspace membership required.")
  expect(screen.getByRole("textbox", { name: "Reply to Dana" })).toHaveValue("No access")
})

function seedPin(item: Record<string, unknown>, patch: (init?: RequestInit) => Response | null) {
  fetchMock.mockImplementation((_url: string, init?: RequestInit) => Promise.resolve(patch(init) ?? new Response(JSON.stringify({
    items: [{ id: "c1", authorName: "Dana", body: "Move this.", elementAnchor: { elementSelector: "a", elementFingerprint: { tag: "a" } }, ...item }],
  }), { status: 200 })))
}
async function openPin() {
  render(<ArtifactViewer {...props} onFeedbackPosted={onPosted} />)
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
  act(() => {
    latestProps.onAnchorsResolved?.({ c1: { status: "anchored", confidence: 1, geometry: { left: 10, top: 20, width: 80, height: 30 } } })
  })
  fireEvent.click(await screen.findByRole("button", { name: /Feedback from Dana/ }))
}
const onPosted = vi.fn()

it("resolves a pinned thread from the card, marks the pin and the card, then reopens it", async () => {
  onPosted.mockReset()
  seedPin({ status: "OPEN", canModerate: true }, (init) => init?.method === "PATCH"
    ? new Response(JSON.stringify({ id: "c1", status: JSON.parse(init.body as string).action === "resolve" ? "RESOLVED" : "OPEN" }), { status: 200 })
    : null)
  await openPin()

  fireEvent.click(screen.getByRole("button", { name: "Resolve thread by Dana" }))
  expect(await screen.findByRole("button", { name: "Reopen thread by Dana" })).toBeInTheDocument()
  const patch = fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH")!
  expect(patch[0]).toBe("/api/comments/c1")
  expect(JSON.parse(patch[1].body as string)).toEqual({ action: "resolve" })
  expect(screen.getByRole("dialog")).toHaveTextContent("Resolved")
  expect(screen.getByRole("button", { name: /Feedback from Dana \(resolved\)/ })).toBeInTheDocument()
  expect(onPosted).toHaveBeenCalledTimes(1)

  fireEvent.click(screen.getByRole("button", { name: "Reopen thread by Dana" }))
  expect(await screen.findByRole("button", { name: "Resolve thread by Dana" })).toBeInTheDocument()
  expect(JSON.parse(fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH")[1][1].body as string)).toEqual({ action: "reopen" })
  expect(screen.getByRole("dialog")).not.toHaveTextContent("Resolved")
})

it("hides Resolve when the viewer can't moderate and shows the error when it is rejected", async () => {
  onPosted.mockReset()
  seedPin({ status: "OPEN", canModerate: false }, () => null)
  await openPin()
  expect(screen.queryByRole("button", { name: /Resolve thread/ })).not.toBeInTheDocument()
  cleanup()
  fetchMock.mockClear()

  seedPin({ status: "OPEN", canModerate: true }, (init) => init?.method === "PATCH"
    ? new Response(JSON.stringify({ error: "Not found" }), { status: 404 })
    : null)
  await openPin()
  fireEvent.click(screen.getByRole("button", { name: "Resolve thread by Dana" }))
  expect(await screen.findByRole("alert")).toHaveTextContent("Not found")
  expect(screen.getByRole("button", { name: "Resolve thread by Dana" })).toBeInTheDocument()
})
