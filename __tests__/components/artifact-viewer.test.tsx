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
