// @vitest-environment jsdom
import { cleanup, render, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ live: vi.fn() }))
vi.mock("next/navigation", () => ({ usePathname: () => "/o/w/docs", useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }))
vi.mock("@/hooks/use-live-refresh", () => ({ useLiveRefresh: mocks.live }))
vi.mock("@/components/docs/doc-tree-sidebar", () => ({ DocTreeSidebar: () => <div>tree</div> }))
import { RailLibraryPane } from "@/components/agent/rail-library-pane"

const fetchMock = vi.fn()
beforeEach(() => {
  vi.clearAllMocks()
  fetchMock.mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ workspaceId: "ws", docs: [], artifacts: [] }))))
  vi.stubGlobal("fetch", fetchMock)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it("watches the docs-tree token only while the Library view is showing, and refetches on change", async () => {
  render(<RailLibraryPane orgSlug="o" workspaceSlug="w" active />)
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
  const options = mocks.live.mock.calls.at(-1)![0]
  expect(options).toMatchObject({ orgSlug: "o", workspaceSlug: "w", scope: "docs-tree", enabled: true })

  options.onChange()
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
  expect(fetchMock.mock.calls[1][0]).toBe("/api/docs-tree?orgSlug=o&workspaceSlug=w")
})

it("does not poll when inactive", () => {
  render(<RailLibraryPane orgSlug="o" workspaceSlug="w" active={false} />)
  expect(mocks.live.mock.calls.at(-1)![0].enabled).toBe(false)
  expect(fetchMock).not.toHaveBeenCalled()
})
