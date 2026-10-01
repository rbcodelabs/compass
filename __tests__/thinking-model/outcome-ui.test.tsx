// @vitest-environment jsdom

/**
 * Component-level proof for Phase 3C, per preset: the workspace tree, the Outcomes
 * index and the Opportunity <-> Objective picker follow the thinking model, and a
 * CLASSIC / NULL / no-provider render of the opportunity header is byte-identical
 * whether or not the picker data is passed (CLASSIC sees no new UI at all).
 * Asserts text and DOM, not layout.
 */
import { type ReactNode } from "react"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, describe, expect, it, vi } from "vitest"

const { openPanel, link, unlink } = vi.hoisted(() => ({
  openPanel: vi.fn(),
  link: vi.fn(async () => ({ ok: true as const, changed: true })),
  unlink: vi.fn(async (): Promise<{ ok: true; changed: boolean; stillLinkedViaKeyResult?: boolean } | { ok: false; error: string }> => ({ ok: true, changed: true })),
}))
vi.mock("@/components/panels/panel-context", () => ({ usePanelContext: () => ({ openPanel, panel: null }) }))
vi.mock("@/app/[orgSlug]/[workspaceSlug]/discovery/actions", () => ({ updateOpportunityStatus: vi.fn(), linkOpportunityToKeyResult: vi.fn() }))
vi.mock("@/app/[orgSlug]/[workspaceSlug]/discovery/objective-link-actions", () => ({
  linkOpportunityToObjectiveAction: link,
  unlinkOpportunityFromObjectiveAction: unlink,
}))
vi.mock("@/components/squads/squad-picker", () => ({ SquadPicker: () => null }))

import { ThinkingModelProvider } from "@/components/thinking-model/thinking-model-provider"
import { resolveThinkingModel } from "@/lib/thinking-model/resolve"
import { buildOutcomeTree } from "@/lib/thinking-model/outcome-tree"
import { OutcomeTreeView } from "@/components/discovery/outcome-tree-view"
import { OutcomesIndex } from "@/components/okrs/outcomes-index"
import { OpportunityHeader } from "@/components/discovery/opportunity-header"

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

// React/base-ui generate sequential ids per render; they are not content.
const stableHtml = (el: HTMLElement) => el.innerHTML.replace(/_r_[0-9a-z]+_/g, "_r_")

const withModel = (source: Parameters<typeof resolveThinkingModel>[0], ui: ReactNode) => (
  <ThinkingModelProvider value={resolveThinkingModel(source)}>{ui}</ThinkingModelProvider>
)

const tree = (shape: "outcome-rooted" | "objective-rooted-pool") =>
  buildOutcomeTree({
    shape,
    objectives: [
      { id: "o1", title: "Grow retention", sortOrder: 0, status: "ON_TRACK", cycle: { id: "c1", title: "Q3" } },
      { id: "o2", title: "Cut costs", sortOrder: 1, status: "AT_RISK" },
    ],
    keyResults: [
      { id: "k1", objectiveId: "o1", title: "Weekly actives", current: 5, target: 10, unit: "k", sortOrder: 0 },
      { id: "k2", objectiveId: "o2", title: "Infra spend", current: 1, target: 4, sortOrder: 0 },
    ],
    opportunities: [
      { id: "p1", title: "Onboarding confuses people", status: "EXPLORING", sortOrder: 0 },
      { id: "p2", title: "Pool need", status: "EXPLORING", sortOrder: 1 },
    ],
    solutions: [{ id: "s1", opportunityId: "p1", title: "Guided tour", status: "IDEA", sortOrder: 0 }],
    objectiveOpportunityLinks: [
      { objectiveId: "o1", opportunityId: "p1" },
      { objectiveId: "o2", opportunityId: "p1" },
    ],
    solutionKeyResultEdges: [
      { solutionId: "s1", keyResultId: "k1" },
      { solutionId: "s1", keyResultId: "k2" },
    ],
    legacyPointers: [],
  })

describe("OutcomeTreeView", () => {
  it("TORRES_OST: says Outcome and Success metric, never Objective or Key Result", () => {
    render(withModel({ thinkingModel: "TORRES_OST" }, <OutcomeTreeView tree={tree("outcome-rooted")} />))
    const root = screen.getByTestId("outcome-tree")
    expect(root).toHaveAttribute("data-shape", "outcome-rooted")
    expect(screen.getAllByText("Success metrics", { selector: "p" }).length).toBeGreaterThan(0)
    expect(root.textContent).not.toMatch(/objective|key result/i)
    // Cycle chip only where there is a cycle.
    expect(screen.getByTestId("outcome-cycle-o1")).toHaveTextContent("Q3")
    expect(screen.queryByTestId("outcome-cycle-o2")).toBeNull()
    // The pool bucket, labelled with the preset's words.
    expect(screen.getByTestId("outcome-pool")).toHaveTextContent("Opportunities not linked to outcomes")
  })

  it("shows the subtree once, a stub elsewhere that expands, and a cross-outcome marker", () => {
    render(withModel({ thinkingModel: "TORRES_OST" }, <OutcomeTreeView tree={tree("outcome-rooted")} />))
    expect(screen.getByTestId("outcome-opportunity-o1-p1")).toBeInTheDocument()
    expect(screen.queryByTestId("outcome-opportunity-o2-p1")).toBeNull()
    const stub = screen.getByTestId("outcome-stub-o2-p1")
    expect(stub).toHaveTextContent("Also under Grow retention")
    expect(screen.getAllByText("Guided tour")).toHaveLength(1)
    fireEvent.click(stub.querySelector("button[aria-expanded]")!)
    expect(screen.getAllByText("Guided tour")).toHaveLength(2)
    // s1 targets k2 under o2; p1 is linked to both, so neither chip is cross-outcome here.
    expect(screen.getAllByTestId("outcome-kr-chip-s1-k1")[0]).toHaveAttribute("data-cross-outcome", "false")
  })

  it("opens the entity panel from a title", () => {
    render(withModel({ thinkingModel: "TORRES_OST" }, <OutcomeTreeView tree={tree("outcome-rooted")} />))
    fireEvent.click(screen.getByRole("button", { name: "Grow retention" }))
    expect(openPanel).toHaveBeenCalledWith("objective", "o1")
  })

  it("OPPORTUNITY_FIRST_OKR: pool first, then Objectives with Key Results and their Solutions", () => {
    render(withModel({ thinkingModel: "OPPORTUNITY_FIRST_OKR" }, <OutcomeTreeView tree={tree("objective-rooted-pool")} />))
    const root = screen.getByTestId("outcome-tree")
    expect(root).toHaveAttribute("data-shape", "objective-rooted-pool")
    expect(root.firstElementChild).toBe(screen.getByTestId("outcome-pool"))
    expect(screen.getAllByText("Key Results", { selector: "p" }).length).toBeGreaterThan(0)
    expect(screen.getByTestId("outcome-metrics-o1")).toHaveTextContent("Guided tour")
  })

  it("an override renames the words in the tree", () => {
    render(
      withModel(
        { thinkingModel: "TORRES_OST", thinkingModelLabels: JSON.stringify({ objective: { singular: "Bet", plural: "Bets" } }) },
        <OutcomeTreeView tree={tree("outcome-rooted")} />,
      ),
    )
    expect(screen.getByTestId("outcome-pool")).toHaveTextContent("Opportunities not linked to bets")
  })

  it("renders an empty state in the preset's words", () => {
    const empty = buildOutcomeTree({ objectives: [], keyResults: [], opportunities: [], solutions: [], objectiveOpportunityLinks: [], solutionKeyResultEdges: [], legacyPointers: [] })
    render(withModel({ thinkingModel: "TORRES_OST" }, <OutcomeTreeView tree={empty} />))
    expect(screen.getByText("No outcomes or opportunities yet")).toBeInTheDocument()
  })
})

describe("OutcomesIndex", () => {
  const rows = [
    { id: "o1", title: "Grow retention", status: "ON_TRACK", cycle: { id: "c1", title: "Q3" }, linkedOpportunityCount: 2 },
    { id: "o2", title: "Persistent goal", status: null, cycle: null, linkedOpportunityCount: 1 },
  ]
  it("lists every row with linked counts and a cycle chip only where a cycle exists", () => {
    render(withModel({ thinkingModel: "TORRES_OST" }, <OutcomesIndex rows={rows} />))
    expect(screen.getByRole("region", { name: "All outcomes" })).toBeInTheDocument()
    expect(screen.getByTestId("outcomes-index-row-o1")).toHaveTextContent("2 linked opportunities")
    expect(screen.getByTestId("outcomes-index-row-o2")).toHaveTextContent("1 linked opportunity")
    expect(screen.getByTestId("outcomes-index-cycle-o1")).toHaveTextContent("Q3")
    expect(screen.queryByTestId("outcomes-index-cycle-o2")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Persistent goal" }))
    expect(openPanel).toHaveBeenCalledWith("objective", "o2")
  })
  it("renders nothing for an empty list", () => {
    const { container } = render(withModel({ thinkingModel: "TORRES_OST" }, <OutcomesIndex rows={[]} />))
    expect(container).toBeEmptyDOMElement()
  })
})

describe("Opportunity header picker", () => {
  const opportunity = {
    id: "opp-1",
    title: "Onboarding",
    description: null,
    customerSegment: null,
    status: "EXPLORING" as const,
    squadId: null,
    linkedKeyResult: null,
  }
  const available = [
    { id: "o1", title: "Grow retention", cycleTitle: "Q3" },
    { id: "o2", title: "Cut costs", cycleTitle: null },
  ]
  const header = (extra: Record<string, unknown> = {}) => (
    <OpportunityHeader opportunity={opportunity} availableKeyResults={[]} squads={[]} revalidatePathStr="/acme/alpha/discovery/opp-1" {...extra} />
  )
  const picker = { linkedObjectives: [{ id: "o1", title: "Grow retention" }], availableObjectives: available }

  it.each([
    ["no provider", (ui: ReactNode) => ui],
    ["NULL key", (ui: ReactNode) => withModel({ thinkingModel: null }, ui)],
    ["explicit CLASSIC", (ui: ReactNode) => withModel({ thinkingModel: "CLASSIC" }, ui)],
  ])("CLASSIC (%s): byte-identical with and without picker data, and no picker", (_name, wrap) => {
    const plain = render(wrap(header()))
    const before = stableHtml(plain.container)
    cleanup()
    const withData = render(wrap(header(picker)))
    expect(stableHtml(withData.container)).toBe(before)
    expect(screen.queryByTestId("opportunity-objective-picker")).toBeNull()
  })

  it("TORRES_OST: shows the picker titled Outcomes with the linked ones", () => {
    render(withModel({ thinkingModel: "TORRES_OST" }, header(picker)))
    const box = screen.getByTestId("opportunity-objective-picker")
    expect(box).toHaveTextContent("Outcomes")
    expect(box).toHaveTextContent("Grow retention")
    expect(box.textContent).not.toMatch(/objective/i)
  })

  it("OPPORTUNITY_FIRST_OKR: shows the picker titled Objectives", () => {
    render(withModel({ thinkingModel: "OPPORTUNITY_FIRST_OKR" }, header(picker)))
    expect(screen.getByTestId("opportunity-objective-picker")).toHaveTextContent("Objectives")
  })

  it("does not render the picker when the option list was not provided", () => {
    render(withModel({ thinkingModel: "TORRES_OST" }, header()))
    expect(screen.queryByTestId("opportunity-objective-picker")).toBeNull()
  })

  it("links and unlinks through the server actions, sending only ids and a path", async () => {
    const onChanged = vi.fn()
    render(withModel({ thinkingModel: "TORRES_OST" }, header({ ...picker, onChanged })))
    fireEvent.click(screen.getByRole("button", { name: "Choose outcomes" }))
    const cutCosts = await screen.findByRole("menuitemcheckbox", { name: /Cut costs/ })
    fireEvent.click(cutCosts)
    await waitFor(() => expect(link).toHaveBeenCalledWith("opp-1", "o2", "/acme/alpha/discovery/opp-1"))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    const retention = await screen.findByRole("menuitemcheckbox", { name: /Grow retention/ })
    fireEvent.click(retention)
    await waitFor(() => expect(unlink).toHaveBeenCalledWith("opp-1", "o1", "/acme/alpha/discovery/opp-1"))
  })

  it("shows the server's message when a call is denied and leaves the selection alone", async () => {
    link.mockResolvedValueOnce({ ok: false, error: "Entity not found or access denied" } as never)
    render(withModel({ thinkingModel: "TORRES_OST" }, header(picker)))
    fireEvent.click(screen.getByRole("button", { name: "Choose outcomes" }))
    fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: /Cut costs/ }))
    expect(await screen.findByRole("alert")).toHaveTextContent("Entity not found or access denied")
    expect(screen.getByTestId("opportunity-objective-picker").querySelectorAll("li")).toHaveLength(1)
  })

  it("explains a link that comes from the driving key result and keeps it", async () => {
    unlink.mockResolvedValueOnce({ ok: true, changed: false, stillLinkedViaKeyResult: true })
    render(withModel({ thinkingModel: "TORRES_OST" }, header(picker)))
    fireEvent.click(screen.getByRole("button", { name: "Choose outcomes" }))
    fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: /Grow retention/ }))
    expect(await screen.findByRole("status")).toHaveTextContent("Still linked through its driving success metric")
    expect(screen.getByTestId("opportunity-objective-picker").querySelectorAll("li")).toHaveLength(1)
  })
})
