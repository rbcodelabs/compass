// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"

const mocks = vi.hoisted(() => ({ replace: vi.fn(), params: new URLSearchParams() }))

vi.mock("@/app/[orgSlug]/[workspaceSlug]/discovery/actions", () => ({
  moveOpportunity: vi.fn(), reorderOpportunity: vi.fn(),
  createOpportunity: vi.fn(),
}))
vi.mock("@/app/[orgSlug]/saved-views-actions", () => ({
  createSavedViewAction: vi.fn(), updateSavedViewAction: vi.fn(), deleteSavedViewAction: vi.fn(),
}))
// The card needs the panel provider and is not what is under test here.
vi.mock("@/components/discovery/opportunity-card", () => ({
  OpportunityCard: ({ opportunity }: { opportunity: { title: string } }) => <div>{opportunity.title}</div>,
}))
vi.mock("@/components/discovery/new-opportunity-button", () => ({ NewOpportunityButton: () => null }))
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.replace, push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/acme/core/discovery",
  useSearchParams: () => mocks.params,
}))

import { OpportunityBoard } from "@/components/discovery/opportunity-board"
import { ColumnsPopover } from "@/components/discovery/columns-popover"
import { resolveOpportunityColumns } from "@/lib/saved-views/opportunity-columns"
import type { OpportunityCardData } from "@/components/discovery/opportunity-card"

const card = (id: string, status: OpportunityCardData["status"]): OpportunityCardData => ({
  id, title: `Card ${id}`, customerSegment: null, status, sortOrder: 0, _count: { solutions: 0, evidence: 0 },
}) as OpportunityCardData

const BY_STATUS = {
  EXPLORING: [card("e1", "EXPLORING")], VALIDATING: [], PRIORITIZED: [], ACTIVE: [], ARCHIVED: [],
}

// Column titles only: the empty-state headings ("No ... yet") are h3s too.
const headings = () =>
  screen.getAllByRole("heading", { level: 3 })
    .map((h) => h.textContent?.replace(/hidden in view, has cards/, "").trim() ?? "")
    .filter((text) => !text.startsWith("No "))

function renderBoard(props: Partial<React.ComponentProps<typeof OpportunityBoard>> = {}) {
  render(<OpportunityBoard opportunitiesByStatus={BY_STATUS} orgSlug="acme" workspaceSlug="core" workspaceId="w1" {...props} />)
}

describe("OpportunityBoard column layout", () => {
  afterEach(cleanup)

  it("renders Active first with no layout", () => {
    renderBoard()
    expect(headings()).toEqual(["Active", "Prioritized", "Validating", "Exploring"])
  })

  it("renders the resolved saved order, appending omitted statuses", () => {
    const { visible } = resolveOpportunityColumns({ order: ["EXPLORING", "VALIDATING"], hidden: [] }, {})
    renderBoard({ columnOrder: visible })
    expect(headings()).toEqual(["Exploring", "Validating", "Active", "Prioritized"])
  })

  it("omits hidden empty columns", () => {
    const { visible } = resolveOpportunityColumns({ order: [], hidden: ["VALIDATING", "PRIORITIZED"] }, { EXPLORING: 1 })
    renderBoard({ columnOrder: visible })
    expect(headings()).toEqual(["Active", "Exploring"])
  })

  it("marks a hidden column that still has cards", () => {
    const cols = resolveOpportunityColumns({ order: [], hidden: ["EXPLORING"] }, { EXPLORING: 1 })
    renderBoard({ columnOrder: cols.visible, forcedVisibleColumns: cols.forcedVisible })
    expect(headings()).toContain("Exploring")
    expect(screen.getByTestId("forced-visible-marker")).toHaveTextContent("hidden in view, has cards")
  })
})

describe("ColumnsPopover", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.params = new URLSearchParams() })
  afterEach(cleanup)

  const open = (layout: { order: string[]; hidden: string[] } | undefined, counts: Record<string, number>, savedViewId: string | null = null) => {
    const columns = resolveOpportunityColumns(layout, counts)
    render(<ColumnsPopover savedViews={{ views: [], savedViewId }} columns={columns} countsByStatus={counts} />)
    fireEvent.click(screen.getByTestId("columns-trigger"))
  }
  const lastHref = () => mocks.replace.mock.calls.at(-1)?.[0] as string

  it("hides an empty column through the hide param", async () => {
    open(undefined, { EXPLORING: 1 })
    fireEvent.click(await screen.findByRole("checkbox", { name: "Show Validating" }))
    expect(lastHref()).toBe("/acme/core/discovery?hide=VALIDATING")
  })

  it("will not hide a column that holds cards", async () => {
    open(undefined, { EXPLORING: 3 })
    expect(await screen.findByRole("checkbox", { name: "Show Exploring" })).toHaveAttribute("aria-disabled", "true")
  })

  it("reorders with the move buttons through the order param", async () => {
    open(undefined, {})
    fireEvent.click(await screen.findByRole("button", { name: "Move Exploring up" }))
    expect(lastHref()).toBe("/acme/core/discovery?order=ACTIVE%2CPRIORITIZED%2CEXPLORING%2CVALIDATING")
  })

  it("cannot move the first column up or the last down", async () => {
    open(undefined, {})
    expect(await screen.findByRole("button", { name: "Move Active up" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Move Exploring down" })).toBeDisabled()
  })

  it("shows the hidden count and lets a forced-visible column be un-hidden", async () => {
    open({ order: [], hidden: ["EXPLORING", "VALIDATING"] }, { EXPLORING: 2 })
    expect(screen.getByTestId("columns-hidden-badge")).toHaveTextContent("1 hidden")
    const row = await screen.findByTestId("columns-row-EXPLORING")
    expect(row).toHaveTextContent("hidden in view, has cards")
    fireEvent.click(within(row).getByRole("checkbox"))
    expect(lastHref()).toBe("/acme/core/discovery?hide=VALIDATING")
  })

  it("keeps a selected saved view selected, in the full edited form", async () => {
    open(undefined, {}, "v1")
    fireEvent.click(await screen.findByRole("checkbox", { name: "Show Exploring" }))
    expect(lastHref()).toBe("/acme/core/discovery?hide=EXPLORING&saved=v1&edited=1")
  })
})
