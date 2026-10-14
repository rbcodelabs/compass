// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({ capture: vi.fn(), refresh: vi.fn() }))
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }))
vi.mock("@/app/[orgSlug]/[workspaceSlug]/docs/actions", () => ({ captureArtifactThumbnail: mocks.capture }))
vi.mock("@/components/docs/artifact-preview", () => ({ ArtifactPreview: () => <div>Preview</div> }))
import { ArtifactDetail } from "@/components/docs/artifact-detail"

const thumbnail = { src: "/t.png", width: 1280, height: 800, capturedAt: "2026-10-01T00:00:00Z" }
function props(overrides: { sourceType?: string; thumbnail?: typeof thumbnail | null; createdAt?: string } = {}) {
  return {
    workspaceId: "ws", basePath: "/o/w/docs", solutions: [], decisions: [],
    artifact: {
      id: "art", title: "Site", description: null, sourceType: overrides.sourceType ?? "EXTERNAL_LINK", status: "ACTIVE",
      currentRevision: { externalUrl: "https://a.example/", thumbnail: overrides.thumbnail ?? null },
      revisions: [{ id: "rev", revisionNumber: 1, filename: null, byteSize: null, externalUrl: "https://a.example/", createdAt: overrides.createdAt ?? "2020-01-01T00:00:00Z" }],
    },
  }
}
beforeEach(() => vi.resetAllMocks())
afterEach(() => { cleanup(); vi.useRealTimers() })

it("offers Capture when an external link has no screenshot, and Refresh when it has one", () => {
  const { rerender } = render(<ArtifactDetail {...props()} />)
  expect(screen.getByRole("button", { name: "Capture screenshot" })).toBeInTheDocument()
  rerender(<ArtifactDetail {...props({ thumbnail })} />)
  expect(screen.getByRole("button", { name: "Refresh screenshot" })).toBeInTheDocument()
})

it("does not offer it for HTML uploads", () => {
  render(<ArtifactDetail {...props({ sourceType: "HTML_UPLOAD" })} />)
  expect(screen.queryByRole("button", { name: /screenshot/i })).toBeNull()
})

it("captures on click and refreshes the page", async () => {
  mocks.capture.mockResolvedValue({ ok: true })
  render(<ArtifactDetail {...props()} />)
  fireEvent.click(screen.getByRole("button", { name: "Capture screenshot" }))
  await waitFor(() => expect(mocks.capture).toHaveBeenCalledWith("ws", "art", "/o/w/docs/artifacts/art"))
  await waitFor(() => expect(mocks.refresh).toHaveBeenCalled())
})

it("shows why a capture failed", async () => {
  mocks.capture.mockResolvedValue({ ok: false, error: "Page returned HTTP 404" })
  render(<ArtifactDetail {...props()} />)
  fireEvent.click(screen.getByRole("button", { name: "Capture screenshot" }))
  expect(await screen.findByRole("alert")).toHaveTextContent("Page returned HTTP 404")
})

it("polls for a just-saved link's background capture, and stops once the window closes", () => {
  vi.useFakeTimers()
  render(<ArtifactDetail {...props({ createdAt: new Date().toISOString() })} />)
  expect(screen.getByText("Capturing a screenshot in the background…")).toBeInTheDocument()
  act(() => { vi.advanceTimersByTime(5_000) })
  expect(mocks.refresh).toHaveBeenCalledTimes(1)
  act(() => { vi.advanceTimersByTime(2 * 60_000) })
  const calls = mocks.refresh.mock.calls.length
  expect(screen.queryByText("Capturing a screenshot in the background…")).toBeNull()
  act(() => { vi.advanceTimersByTime(30_000) })
  expect(mocks.refresh).toHaveBeenCalledTimes(calls)
})

it("does not poll for an old revision", () => {
  vi.useFakeTimers()
  render(<ArtifactDetail {...props()} />)
  act(() => { vi.advanceTimersByTime(30_000) })
  expect(mocks.refresh).not.toHaveBeenCalled()
})
