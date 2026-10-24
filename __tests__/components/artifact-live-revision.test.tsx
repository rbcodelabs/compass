// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ refresh: vi.fn(), live: vi.fn(), mounts: vi.fn() }))
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }))
vi.mock("@/hooks/use-live-refresh", () => ({ useLiveRefresh: mocks.live }))
vi.mock("@/app/[orgSlug]/[workspaceSlug]/docs/actions", () => ({}))
vi.mock("@/components/docs/artifact-viewer", async () => {
  const React = await import("react")
  return {
    ArtifactViewer: ({ html }: { html?: string }) => {
      // A mount counter proves the viewer (and so its slide index / draft state) is not remounted on a new revision.
      React.useEffect(() => { mocks.mounts() }, [])
      return <div data-testid="viewer">{html}</div>
    },
  }
})
import { ArtifactDetail } from "@/components/docs/artifact-detail"

function props(revisionNumbers: number[], html: string) {
  return {
    workspaceId: "ws", basePath: "/o/w/docs", solutions: [], decisions: [], html,
    artifact: {
      id: "art", title: "Deck", description: null, sourceType: "HTML_UPLOAD", status: "ACTIVE",
      currentRevision: null,
      revisions: revisionNumbers.map((n) => ({ id: `r${n}`, revisionNumber: n, filename: "a.html", byteSize: 1, externalUrl: null, createdAt: "2020-01-01T00:00:00Z" })),
    },
  }
}
beforeEach(() => vi.resetAllMocks())
afterEach(() => { cleanup(); vi.useRealTimers() })

it("subscribes to the artifact's entity-scoped change token", () => {
  render(<ArtifactDetail {...props([1], "<p>1</p>")} />)
  expect(mocks.live).toHaveBeenCalledWith(expect.objectContaining({ orgSlug: "o", workspaceSlug: "w", scope: "artifact:art" }))
})

it("announces a revision that arrives while open, keeps the viewer mounted, then clears", () => {
  vi.useFakeTimers()
  const { rerender } = render(<ArtifactDetail {...props([1], "<p>1</p>")} />)
  expect(screen.queryByText(/is now showing/)).toBeNull()
  rerender(<ArtifactDetail {...props([2, 1], "<p>2</p>")} />)
  expect(screen.getByRole("status")).toHaveTextContent("New revision 2 is now showing.")
  expect(screen.getByTestId("viewer")).toHaveTextContent("2")
  expect(mocks.mounts).toHaveBeenCalledTimes(1)
  act(() => { vi.advanceTimersByTime(7_000) })
  expect(screen.queryByText(/is now showing/)).toBeNull()
})
