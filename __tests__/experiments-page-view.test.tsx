// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  getWorkspace: vi.fn(),
  squads: vi.fn(),
  experiments: vi.fn(),
  loadExtras: vi.fn(),
  redirect: vi.fn((url: string) => { throw new Error(`NEXT_REDIRECT:${url}`) }),
}))

vi.mock("@/auth", () => ({ auth: mocks.auth }))
vi.mock("@/lib/workspace", () => ({ getWorkspace: mocks.getWorkspace }))
vi.mock("@/lib/db", () => ({ default: () => ({ squad: { findMany: mocks.squads }, experiment: { findMany: mocks.experiments } }) }))
vi.mock("@/lib/experiments/gallery-server", () => ({ loadExperimentGalleryExtras: mocks.loadExtras }))
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }))
// Shells and heavy children: the page's job here is which of them it renders and with what.
vi.mock("@/components/patterns/workspace-page", () => ({
  WorkspacePage: ({ actions, children }: { actions: React.ReactNode; children: React.ReactNode }) => <div><div data-testid="actions">{actions}</div>{children}</div>,
}))
vi.mock("@/components/experiments/experiment-board", () => ({ ExperimentBoard: () => <div data-testid="board" /> }))
vi.mock("@/components/experiments/experiments-gallery", () => ({
  ExperimentsGallery: (props: { groupMode: string; experiments: unknown[]; extras: unknown }) => <div data-testid="gallery" data-group-mode={props.groupMode} data-count={props.experiments.length} data-extras={JSON.stringify(props.extras)} />,
}))
vi.mock("@/components/experiments/experiments-view-toggle", () => ({ ExperimentsViewToggle: ({ view }: { view: string }) => <div data-testid="view-toggle" data-view={view} /> }))
vi.mock("@/components/experiments/experiments-group-by-toggle", () => ({ ExperimentsGroupByToggle: ({ value }: { value: string }) => <div data-testid="group-by" data-value={value} /> }))
vi.mock("@/components/experiments/experiments-filters", () => ({ ExperimentsFilters: () => <div data-testid="filters" /> }))
vi.mock("@/components/experiments/new-experiment-button", () => ({ NewExperimentButton: () => <div data-testid="new" /> }))

import ExperimentsPage from "@/app/[orgSlug]/[workspaceSlug]/experiments/page"

const row = (id: string, over: Record<string, unknown> = {}) => ({ id, title: id, hypothesis: "h", killCondition: "k", status: "RUNNING", sortOrder: 0, conclusion: null, squadId: null, ...over })
const page = async (search: Record<string, string> = {}) =>
  render(await ExperimentsPage({ params: Promise.resolve({ orgSlug: "acme", workspaceSlug: "product" }), searchParams: Promise.resolve(search) }))

describe("experiments page view handling", () => {
  afterEach(cleanup)
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.auth.mockResolvedValue({ user: { id: "u1" } })
    mocks.getWorkspace.mockResolvedValue({ id: "ws-1" })
    mocks.squads.mockResolvedValue([{ id: "s1", name: "Growth", color: "#111" }])
    mocks.experiments.mockResolvedValue([row("e1", { squadId: "s1" }), row("e2")])
    mocks.loadExtras.mockResolvedValue({ e1: { artifacts: [], moreArtifacts: 0 } })
  })

  it("renders the board by default and never loads gallery extras", async () => {
    await page()
    expect(screen.getByTestId("board")).toBeInTheDocument()
    expect(screen.queryByTestId("gallery")).toBeNull()
    expect(screen.getByTestId("view-toggle")).toHaveAttribute("data-view", "board")
    expect(screen.queryByTestId("group-by")).toBeNull()
    expect(mocks.loadExtras).not.toHaveBeenCalled()
  })

  it("treats an unknown view as the board", async () => {
    await page({ view: "kanban" })
    expect(screen.getByTestId("board")).toBeInTheDocument()
    expect(mocks.loadExtras).not.toHaveBeenCalled()
  })

  it("renders the gallery for ?view=gallery, loading extras once for the shown experiments, ahead of the filters", async () => {
    await page({ view: "gallery" })
    expect(screen.getByTestId("gallery")).toHaveAttribute("data-count", "2")
    expect(screen.queryByTestId("board")).toBeNull()
    expect(mocks.loadExtras).toHaveBeenCalledTimes(1)
    expect(mocks.loadExtras).toHaveBeenCalledWith(expect.anything(), "ws-1", ["e1", "e2"])
    const order = Array.from(screen.getByTestId("actions").children).map((el) => el.getAttribute("data-testid"))
    expect(order).toEqual(["view-toggle", "group-by", "filters", "new"])
  })

  it("defaults the gallery grouping to status and honours ?groupBy=", async () => {
    await page({ view: "gallery" })
    expect(screen.getByTestId("gallery")).toHaveAttribute("data-group-mode", "status")
    cleanup()
    await page({ view: "gallery", groupBy: "conclusion" })
    expect(screen.getByTestId("gallery")).toHaveAttribute("data-group-mode", "conclusion")
  })

  it("filters server-side by ?squad= in both views", async () => {
    await page({ view: "gallery", squad: "s1" })
    expect(mocks.experiments.mock.calls[0][0].where).toMatchObject({ workspaceId: "ws-1", squadId: "s1" })
    cleanup()
    mocks.experiments.mockClear()
    await page({ squad: "s1" })
    expect(mocks.experiments.mock.calls[0][0].where).toMatchObject({ workspaceId: "ws-1", squadId: "s1" })
  })

  it("carries view and squad through the legacy ?assumptionId= redirect", async () => {
    await expect(page({ assumptionId: "abc", view: "gallery", squad: "s1", groupBy: "squad" })).rejects.toThrow(/NEXT_REDIRECT:\/acme\/product\/experiments\?/)
    const url = new URL(mocks.redirect.mock.calls[0][0] as string, "http://x")
    expect(url.searchParams.get("view")).toBe("gallery")
    expect(url.searchParams.get("squad")).toBe("s1")
    expect(url.searchParams.get("groupBy")).toBe("squad")
    expect(url.searchParams.get("detail")).toMatch(/^experiment-new:/)
    expect(mocks.experiments).not.toHaveBeenCalled()
  })

  it("keeps the legacy redirect unchanged when no view is set", async () => {
    await expect(page({ assumptionId: "abc" })).rejects.toThrow(/NEXT_REDIRECT/)
    const url = new URL(mocks.redirect.mock.calls[0][0] as string, "http://x")
    expect(url.searchParams.has("view")).toBe(false)
    expect(url.searchParams.has("squad")).toBe(false)
  })
})
