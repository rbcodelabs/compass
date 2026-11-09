// @vitest-environment jsdom

import { createElement } from "react"
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { GalleryArtifactSet } from "@/lib/gallery/artifacts"
import type { ExperimentGalleryItem } from "@/lib/experiments/gallery"

const mocks = vi.hoisted(() => ({
  openPanel: vi.fn(),
  liveRefresh: vi.fn(),
  capture: vi.fn(async () => ({ ok: true as const })),
  push: vi.fn(),
  search: { current: new URLSearchParams() },
}))

vi.mock("@/components/panels/panel-context", () => ({ usePanelContext: () => ({ openPanel: mocks.openPanel }) }))
vi.mock("@/hooks/use-live-refresh", () => ({ useLiveRefresh: mocks.liveRefresh }))
vi.mock("@/app/[orgSlug]/[workspaceSlug]/docs/actions", () => ({ captureArtifactThumbnail: mocks.capture }))
vi.mock("next/navigation", () => ({
  usePathname: () => "/acme/product/experiments",
  useRouter: () => ({ push: mocks.push }),
  useSearchParams: () => mocks.search.current,
}))

// The real Select is a popup widget driven by pointer events; the E2E spec drives it. Here a flat stand-in keeps the
// assertion on what the toggle does with the chosen value.
vi.mock("@/components/ui/select", async () => {
  const React = await import("react")
  const Ctx = React.createContext<(value: string) => void>(() => {})
  return {
    Select: ({ onValueChange, children }: { onValueChange: (value: string) => void; children: React.ReactNode }) => <Ctx.Provider value={onValueChange}>{children}</Ctx.Provider>,
    SelectTrigger: ({ children, ...props }: React.ComponentProps<"button">) => <button role="combobox" {...props}>{children}</button>,
    SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => {
      const choose = React.useContext(Ctx)
      return <button role="option" onClick={() => choose(value)}>{children}</button>
    },
  }
})
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ render }: { render: React.ReactElement }) => render,
  TooltipContent: () => null,
}))

import { ExperimentsGallery } from "@/components/experiments/experiments-gallery"
import { ExperimentsViewToggle } from "@/components/experiments/experiments-view-toggle"
import { ExperimentsGroupByToggle } from "@/components/experiments/experiments-group-by-toggle"

afterEach(cleanup)
beforeEach(() => { vi.clearAllMocks(); mocks.search.current = new URLSearchParams() })

const squads = [{ id: "s1", name: "Growth", color: "#111111" }]
const exp = (id: string, over: Partial<ExperimentGalleryItem> = {}): ExperimentGalleryItem => ({
  id, title: `Exp ${id}`, hypothesis: `We believe ${id}`, status: "RUNNING", conclusion: null, squad: null, ...over,
})
const shot = { src: "/api/artifacts/a1/revisions/r1/thumbnail?v=1", width: 800, height: 500, capturedAt: "2026-01-01T00:00:00.000Z" }
const withArtifacts: GalleryArtifactSet = {
  artifacts: [
    { id: "a0", title: "No shot", sourceType: "HTML_UPLOAD", kind: "DOCUMENT", thumbnail: null, capturable: true },
    { id: "a1", title: "Has shot", sourceType: "HTML_UPLOAD", kind: "DOCUMENT", thumbnail: shot, capturable: true },
  ],
  moreArtifacts: 0,
}
const none: GalleryArtifactSet = { artifacts: [], moreArtifacts: 0 }
const renderGallery = (experiments: ExperimentGalleryItem[], extras: Record<string, GalleryArtifactSet>, groupMode: "status" | "squad" | "conclusion" | "none" = "status") =>
  render(createElement(ExperimentsGallery, { experiments, extras, squads, groupMode, workspaceId: "ws-1", orgSlug: "acme", workspaceSlug: "product" }))

describe("ExperimentsGallery", () => {
  it("subscribes to live refresh for the experiments scope", () => {
    renderGallery([exp("1")], {})
    expect(mocks.liveRefresh).toHaveBeenCalledWith(expect.objectContaining({ orgSlug: "acme", workspaceSlug: "product", scope: "experiments" }))
  })

  it("shows title, status, hypothesis and squad, with the hero on the artifact that has a screenshot", () => {
    renderGallery([exp("1", { squad: squads[0] })], { "1": withArtifacts })
    const card = screen.getByTestId("gallery-card")
    expect(within(card).getByRole("button", { name: "Exp 1" })).toBeInTheDocument()
    expect(within(card).getByText("Running", { selector: "span" })).toBeInTheDocument()
    expect(within(card).getByText("We believe 1")).toBeInTheDocument()
    expect(within(card).getByText("Growth")).toBeInTheDocument()
    expect(within(card).getByRole("img", { name: "Preview of Has shot" })).toHaveAttribute("src", shot.src)
  })

  it("shows a conclusion badge only for a concluded experiment", () => {
    renderGallery([exp("1", { status: "COMPLETE", conclusion: "PROCEED" }), exp("2")], {}, "none")
    const [concluded, open] = screen.getAllByTestId("gallery-card")
    expect(within(concluded).getByText("Proceed")).toBeInTheDocument()
    expect(within(open).queryByText("Proceed")).toBeNull()
  })

  it("tells the user to link an artifact from the experiment panel when none is linked", () => {
    renderGallery([exp("1")], {})
    expect(screen.getByTestId("gallery-hero-empty")).toHaveTextContent("No artifact is linked to this experiment yet")
    expect(screen.getByTestId("gallery-hero-empty")).toHaveTextContent("link an artifact from the experiment panel")
  })

  it("opens the experiment panel when the card is clicked", () => {
    renderGallery([exp("7")], {})
    fireEvent.click(screen.getByRole("button", { name: "Exp 7" }))
    expect(mocks.openPanel).toHaveBeenCalledWith("experiment", "7")
  })

  it("captures through the generic artifact action, revalidating the experiments page", async () => {
    renderGallery([exp("1")], { "1": { artifacts: [withArtifacts.artifacts[0]], moreArtifacts: 0 } })
    fireEvent.click(screen.getByRole("button", { name: "Capture preview" }))
    await vi.waitFor(() => expect(mocks.capture).toHaveBeenCalledWith("ws-1", "a0", "/acme/product/experiments"))
  })

  it("groups by status with board labels, collapses a group, and lists none ungrouped", () => {
    const { rerender } = renderGallery([exp("1", { status: "DESIGNING" }), exp("2", { status: "KILLED" })], {})
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual(["Designing", "Killed"])
    const toggle = screen.getAllByRole("button", { expanded: true })[0]
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute("aria-expanded", "false")
    rerender(createElement(ExperimentsGallery, { experiments: [exp("1"), exp("2")], extras: {}, squads, groupMode: "none", workspaceId: "ws-1", orgSlug: "acme", workspaceSlug: "product" }))
    expect(screen.queryAllByRole("heading", { level: 2 })).toHaveLength(0)
    expect(screen.getAllByTestId("gallery-card")).toHaveLength(2)
  })

  it("renders an empty state, still live-refreshing, when there are no experiments", () => {
    renderGallery([], {})
    expect(screen.getByTestId("gallery-empty")).toBeInTheDocument()
    expect(mocks.liveRefresh).toHaveBeenCalled()
  })
})

describe("ExperimentsViewToggle", () => {
  it("Gallery writes ?view=gallery and keeps the squad filter", () => {
    mocks.search.current = new URLSearchParams("squad=s1")
    render(createElement(ExperimentsViewToggle, { view: "board" }))
    fireEvent.click(screen.getByRole("tab", { name: "Gallery" }))
    expect(mocks.push).toHaveBeenCalledWith("/acme/product/experiments?squad=s1&view=gallery", { scroll: false })
  })
  it("Board drops view and groupBy, keeping the squad filter", () => {
    mocks.search.current = new URLSearchParams("view=gallery&groupBy=squad&squad=s1")
    render(createElement(ExperimentsViewToggle, { view: "gallery" }))
    fireEvent.click(screen.getByRole("tab", { name: "Board" }))
    expect(mocks.push).toHaveBeenCalledWith("/acme/product/experiments?squad=s1", { scroll: false })
  })
  it("Board with nothing else pushes the bare path", () => {
    mocks.search.current = new URLSearchParams("view=gallery")
    render(createElement(ExperimentsViewToggle, { view: "gallery" }))
    fireEvent.click(screen.getByRole("tab", { name: "Board" }))
    expect(mocks.push).toHaveBeenCalledWith("/acme/product/experiments", { scroll: false })
  })
})

describe("ExperimentsGroupByToggle", () => {
  it("is named 'Group gallery by' and writes groupBy, with Status (the default) as no param", async () => {
    mocks.search.current = new URLSearchParams("view=gallery")
    render(createElement(ExperimentsGroupByToggle, { value: "status" }))
    const trigger = screen.getByRole("combobox", { name: "Group gallery by" })
    fireEvent.click(trigger)
    fireEvent.click(await screen.findByRole("option", { name: "Conclusion" }))
    expect(mocks.push).toHaveBeenCalledWith("/acme/product/experiments?view=gallery&groupBy=conclusion", { scroll: false })
  })
})
