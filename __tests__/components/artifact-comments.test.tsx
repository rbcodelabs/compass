// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }))
vi.mock("@/app/[orgSlug]/[workspaceSlug]/docs/actions", () => ({}))
vi.mock("@/components/docs/artifact-preview", () => ({ ArtifactPreview: () => <input aria-label="Preview control" defaultValue="interactive" /> }))
import { ArtifactDetail } from "@/components/docs/artifact-detail"

const props = { workspaceId: "ws", basePath: "/acme/product/docs", artifact: { id: "artifact", title: "Prototype", description: null, sourceType: "HTML_UPLOAD", status: "ACTIVE", currentRevision: null, revisions: [] }, solutions: [], decisions: [] }
const fetchMock = vi.fn()
beforeEach(() => {
  fetchMock.mockReset().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ items: [] }))))
  vi.stubGlobal("fetch", fetchMock)
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }))
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 1200 } as DOMRect)
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.cookie = "compass_panel_artifactComments=; Path=/; Max-Age=0" })

it("eagerly loads anchors for pins, independently of the Discussion panel", async () => {
  render(<ArtifactDetail {...props} />)
  // The pin overlay needs existing anchored comments whether or not the
  // Comments panel has ever been opened, so ArtifactViewer fetches on mount —
  // unlike Discussion (components/comments/discussion.tsx), which stays lazy.
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
  expect(fetchMock.mock.calls[0][0]).toBe("/api/comments?targetType=ARTIFACT&targetId=artifact")
  fireEvent.click(screen.getByRole("button", { name: "Comments" }))
  expect(await screen.findByText("No comments yet.")).toBeVisible()
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
})

it("preserves a draft and preview across pinning, closing, reopening and refresh", async () => {
  const { rerender } = render(<ArtifactDetail {...props} />)
  const preview = screen.getByRole("textbox", { name: "Preview control" })
  fireEvent.click(screen.getByRole("button", { name: "Comments" }))
  await screen.findByText("No comments yet.")
  fireEvent.change(screen.getByRole("textbox", { name: "Add comment" }), { target: { value: "Keep this draft" } })
  fireEvent.click(screen.getByRole("button", { name: "Pin panel" }))
  expect(screen.getByRole("complementary", { name: "Comments" })).toBeVisible()
  expect(document.cookie).toContain("compass_panel_artifactComments=1:448")
  expect(screen.getByRole("textbox", { name: "Add comment" })).toHaveValue("Keep this draft")
  fireEvent.click(screen.getByRole("button", { name: "Close panel" }))
  fireEvent.click(screen.getByRole("button", { name: "Comments" }))
  rerender(<ArtifactDetail {...props} artifact={{ ...props.artifact, title: "Updated prototype" }} />)
  expect(screen.getByRole("textbox", { name: "Add comment" })).toHaveValue("Keep this draft")
  expect(screen.getByRole("textbox", { name: "Preview control" })).toBe(preview)
  // 1 eager ArtifactViewer pin fetch + 2 Discussion fetches (initial open, reopen refresh).
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))
})

it("resets discussion drafts when navigating to another Artifact", async () => {
  const { rerender } = render(<ArtifactDetail {...props} />)
  fireEvent.click(screen.getByRole("button", { name: "Comments" }))
  await screen.findByText("No comments yet.")
  fireEvent.change(screen.getByRole("textbox", { name: "Add comment" }), { target: { value: "First artifact draft" } })
  rerender(<ArtifactDetail {...props} artifact={{ ...props.artifact, id: "second" }} />)
  await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url === "/api/comments?targetType=ARTIFACT&targetId=second")).toBe(true))
  expect(screen.getByRole("textbox", { name: "Add comment" })).toHaveValue("")
})
