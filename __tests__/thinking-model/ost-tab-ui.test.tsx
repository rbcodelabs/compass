// @vitest-environment jsdom

/**
 * The OST tab across the whole stack, per thinking model: which levels are drawn, every name from the labels, clicks open
 * the entity's panel. The derivation itself is covered in opportunity-chain.test.ts.
 */
import { type ReactNode } from "react"
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, describe, expect, it, vi } from "vitest"

const { openPanel } = vi.hoisted(() => ({ openPanel: vi.fn() }))
vi.mock("@/components/panels/panel-context", () => ({
  usePanelContext: () => ({ openPanel, closePanel: vi.fn(), notifyEntityMutated: vi.fn(), panel: null }),
}))
import { ThinkingModelProvider } from "@/components/thinking-model/thinking-model-provider"
import { resolveThinkingModel } from "@/lib/thinking-model/resolve"
import { OSTTreeView, type OSTOpportunityNode } from "@/components/discovery/ost-tree-view"

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const withModel = (source: Parameters<typeof resolveThinkingModel>[0], ui: ReactNode) => (
  <ThinkingModelProvider value={resolveThinkingModel(source)}>{ui}</ThinkingModelProvider>
)
const CLASSIC = { thinkingModel: null }
const OFO = { thinkingModel: "OPPORTUNITY_FIRST_OKR" }
const TORRES = { thinkingModel: "TORRES_OST" }
const CUSTOM_TORRES = {
  thinkingModel: "TORRES_OST",
  thinkingModelLabels: JSON.stringify({ objective: { singular: "Aim", plural: "Aims" }, keyResult: { singular: "Signal", plural: "Signals" } }),
}

const opportunity: OSTOpportunityNode = {
  id: "o1",
  title: "Slow onboarding",
  status: "EXPLORING",
  linkedKeyResult: { id: "kr-legacy", title: "Legacy KR", objective: { id: "obj-a", title: "Grow" } },
  linkedObjectives: [
    { id: "obj-a", title: "Grow" },
    { id: "obj-b", title: "Retain" },
  ],
  chainObjectives: [
    { id: "obj-a", title: "Grow", keyResults: [{ id: "kr-a1", title: "Activation", current: 4, target: 10 }] },
    { id: "obj-b", title: "Retain", keyResults: [] },
  ],
  roadmapItems: [{ id: "r1", title: "Onboarding revamp", horizon: "NOW", status: "ACTIVE", solutionId: null }],
  deliveryTasks: [{ id: "t1", title: "Wire the tour", status: "IN_PROGRESS" }],
  solutions: [
    {
      id: "s1",
      title: "Guided tour",
      status: "IDEA",
      linkedKeyResults: [{ id: "kr-a1", title: "Activation", objectiveId: "obj-a" }],
      assumptions: [{ id: "a1", title: "Users want tours", riskLevel: "HIGH", status: "UNTESTED", experiments: [] }],
      roadmapItems: [{ id: "r2", title: "Tour v1", horizon: "NEXT", status: "ACTIVE" }],
    },
  ],
}

const renderTab = (source: Parameters<typeof resolveThinkingModel>[0], data: OSTOpportunityNode = opportunity) =>
  render(withModel(source, <OSTTreeView opportunity={data} orgSlug="acme" workspaceSlug="alpha" />))

describe("OST tab", () => {
  it("CLASSIC: Key Result root with its Objective title; no typed parents, chips or strip; delivery leaves shown when present", () => {
    renderTab(CLASSIC)
    expect(screen.getByText("Legacy KR")).toBeInTheDocument()
    expect(screen.queryByTestId("ost-parents")?.textContent).not.toContain("Retain")
    expect(screen.queryByTestId("ost-kr-chips")).toBeNull()
    expect(screen.queryByTestId("ost-metrics")).toBeNull()
    expect(screen.getByText("Onboarding revamp")).toBeInTheDocument()
    expect(screen.getByText("Tour v1")).toBeInTheDocument()
    expect(screen.getByText("Wire the tour")).toBeInTheDocument()
  })

  it("OPPORTUNITY_FIRST_OKR: every linked Objective is a parent once, the Key Result is a node, solutions carry chips", () => {
    renderTab(OFO)
    const parents = screen.getByTestId("ost-parents")
    expect(within(parents).getByText("Grow")).toBeInTheDocument()
    expect(within(parents).getByText("Retain")).toBeInTheDocument()
    expect(within(parents).getByText("Legacy KR")).toBeInTheDocument()
    expect(screen.getAllByText("Slow onboarding")).toHaveLength(1)
    expect(within(screen.getByTestId("ost-kr-chips")).getByText("Activation")).toBeInTheDocument()
    expect(screen.queryByTestId("ost-metrics")).toBeNull()
  })

  it("TORRES_OST: Outcomes are roots, Key Results are a chip strip (not nodes), the legacy Key Result is not drawn", () => {
    renderTab(TORRES)
    const parents = screen.getByTestId("ost-parents")
    expect(within(parents).getByText("Grow")).toBeInTheDocument()
    expect(within(parents).getByText("Retain")).toBeInTheDocument()
    expect(screen.queryByText("Legacy KR")).toBeNull()
    expect(within(screen.getByTestId("ost-metrics")).getByText("Activation")).toBeInTheDocument()
    expect(within(screen.getByTestId("ost-metrics")).getByText("40%")).toBeInTheDocument()
    expect(within(screen.getByTestId("ost-kr-chips")).getByText("Activation")).toBeInTheDocument()
    // Labels come from the model, not hard-coded entity words.
    expect(screen.getAllByText("Outcome").length).toBeGreaterThan(0)
    expect(screen.getAllByText("Success metric").length).toBeGreaterThan(0)
    expect(screen.queryByText("Objective")).toBeNull()
    expect(screen.queryByText("Key Result")).toBeNull()
  })

  it("label overrides replace every name, including the legend", () => {
    renderTab(CUSTOM_TORRES)
    expect(screen.getAllByText("Aim").length).toBeGreaterThan(0)
    expect(screen.getAllByText("Signal").length).toBeGreaterThan(0)
    expect(screen.queryByText("Outcome")).toBeNull()
    expect(screen.queryByText("Success metric")).toBeNull()
  })

  it("no links and no parents: the opportunity is the root and the legend still adapts", () => {
    renderTab(TORRES, { ...opportunity, linkedKeyResult: null, linkedObjectives: [], chainObjectives: [], roadmapItems: [], deliveryTasks: [], solutions: [] })
    expect(screen.queryByTestId("ost-parents")).toBeNull()
    expect(screen.getByText("Slow onboarding")).toBeInTheDocument()
    expect(screen.getByText("No solutions yet")).toBeInTheDocument()
  })

  it("nodes open their entity's panel", () => {
    renderTab(OFO)
    fireEvent.click(within(screen.getByTestId("ost-parents")).getByText("Retain"))
    expect(openPanel).toHaveBeenLastCalledWith("objective", "obj-b")
    fireEvent.click(screen.getByText("Guided tour"))
    expect(openPanel).toHaveBeenLastCalledWith("solution", "s1")
    fireEvent.click(screen.getByText("Users want tours"))
    expect(openPanel).toHaveBeenLastCalledWith("assumption", "a1")
    fireEvent.click(screen.getByText("Tour v1"))
    expect(openPanel).toHaveBeenLastCalledWith("roadmapItem", "r2")
    fireEvent.click(screen.getByText("Wire the tour"))
    expect(openPanel).toHaveBeenLastCalledWith("task", "t1")
    fireEvent.click(within(screen.getByTestId("ost-kr-chips")).getByText("Activation"))
    expect(openPanel).toHaveBeenLastCalledWith("keyResult", "kr-a1")
  })
})
