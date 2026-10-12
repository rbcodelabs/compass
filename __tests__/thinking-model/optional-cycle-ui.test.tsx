// @vitest-environment jsdom

/**
 * Phase 4C-1: the optional-cycle (#332) surfaces composed with the thinking models, per preset.
 * CLASSIC reads exactly what #332 shipped; Torres shows each cycle-less Objective once (in the Outcomes
 * index, never also as the "No cycle / Persistent" card) and does not announce the absence of a cycle.
 * Asserts text and DOM, not layout.
 */
import { type ReactNode } from "react"
import { cleanup, render, screen } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { detail, db, outcomesIndex, objectiveCount } = vi.hoisted(() => ({
  detail: { data: {} as Record<string, unknown> },
  outcomesIndex: { rows: [] as Array<Record<string, unknown>> },
  objectiveCount: vi.fn(async () => 0),
  db: { workspace: {} as Record<string, unknown>, cycles: [] as Array<Record<string, unknown>> },
}))

vi.mock("@/auth", () => ({ auth: async () => ({ user: { id: "u1" } }) }))
vi.mock("@/lib/db", () => ({
  default: () => ({
    workspace: { findFirst: async () => db.workspace },
    oKRCycle: { findMany: async () => db.cycles },
    objective: { count: objectiveCount },
  }),
}))
vi.mock("@/lib/workspace-context", () => ({ getWorkspaceContext: async () => ({ status: "none" }) }))
vi.mock("@/lib/thinking-model/outcome-tree-data", () => ({ loadOutcomesIndex: async () => outcomesIndex }))
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("notFound")
  },
  redirect: () => {
    throw new Error("redirect")
  },
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/acme/alpha/okrs",
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock("@/components/panels/panel-context", () => ({
  usePanelContext: () => ({ openPanel: vi.fn(), closePanel: vi.fn(), notifyEntityMutated: vi.fn(), panel: null }),
}))
vi.mock("@/components/panels/panel-parts", async (load) => ({
  ...(await load<typeof import("@/components/panels/panel-parts")>()),
  useEntityDetail: () => ({ data: detail.data, error: false, mutate: vi.fn(), refresh: vi.fn() }),
}))
vi.mock("@/app/[orgSlug]/[workspaceSlug]/okrs/actions", () => ({
  createCycle: vi.fn(),
  createObjective: vi.fn(),
}))
vi.mock("@/components/comments/discussion", () => ({ Discussion: () => null }))
vi.mock("@/components/tasks/linked-tasks-section", () => ({ LinkedTasksSection: () => null }))
vi.mock("@/components/analytics/measurements-panel", () => ({ MeasurementsPanel: () => null }))
vi.mock("@/components/discovery/solution-key-result-picker", () => ({ SolutionKeyResultPicker: () => null }))

import { ThinkingModelProvider } from "@/components/thinking-model/thinking-model-provider"
import { resolveThinkingModel } from "@/lib/thinking-model/resolve"
import { PersistentObjectivesCard } from "@/components/okrs/persistent-objectives-card"
import { ObjectivePanel } from "@/components/panels/objective-panel"
import { KeyResultPanel } from "@/components/panels/key-result-panel"
import OKRsPage from "@/app/[orgSlug]/[workspaceSlug]/okrs/page"

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

type Source = Parameters<typeof resolveThinkingModel>[0]
const withModel = (source: Source, ui: ReactNode) => <ThinkingModelProvider value={resolveThinkingModel(source)}>{ui}</ThinkingModelProvider>

const CLASSIC: Source = { thinkingModel: null }
const OPPORTUNITY_FIRST: Source = { thinkingModel: "OPPORTUNITY_FIRST_OKR" }
const TORRES: Source = { thinkingModel: "TORRES_OST" }

describe("PersistentObjectivesCard per preset", () => {
  const card = (count: number) => <PersistentObjectivesCard objectiveCount={count} orgSlug="acme" workspaceSlug="alpha" />

  it("CLASSIC reads exactly what #332 shipped", () => {
    render(withModel(CLASSIC, card(0)))
    expect(screen.getByText("No cycle / Persistent")).toBeInTheDocument()
    expect(screen.getByText("Objectives not tied to a planning period")).toBeInTheDocument()
    expect(screen.getByText("No objectives yet")).toBeInTheDocument()
    expect(screen.getByTestId("persistent-objectives-card")).toHaveAttribute("href", "/acme/alpha/okrs/none")
    cleanup()
    render(withModel(CLASSIC, card(1)))
    expect(screen.getByText("1 objective")).toBeInTheDocument()
    cleanup()
    render(withModel(CLASSIC, card(3)))
    expect(screen.getByText("3 objectives")).toBeInTheDocument()
  })

  it("renders with no provider exactly like CLASSIC", () => {
    render(card(2))
    expect(screen.getByText("No cycle / Persistent")).toBeInTheDocument()
    expect(screen.getByText("2 objectives")).toBeInTheDocument()
  })

  it("follows an Objective label override", () => {
    render(withModel({ thinkingModel: "CLASSIC", thinkingModelLabels: JSON.stringify({ objective: { singular: "Goal", plural: "Goals" } }) }, card(2)))
    expect(screen.getByText("Goals not tied to a planning period")).toBeInTheDocument()
    expect(screen.getByText("2 goals")).toBeInTheDocument()
  })

  it("follows the Torres vocabulary", () => {
    render(withModel(TORRES, card(1)))
    expect(screen.getByText("Outcomes not tied to a planning period")).toBeInTheDocument()
    expect(screen.getByText("1 outcome")).toBeInTheDocument()
  })
})

describe("/okrs index composes cycle-less Objectives once per preset", () => {
  const workspace = (source: Source) => ({ id: "w1", slug: "alpha", ...source })
  const cycle = { id: "c1", title: "Q3", startDate: new Date("2026-07-01"), endDate: new Date("2026-09-30"), status: "ACTIVE", objectives: [{ status: "ON_TRACK", keyResults: [] }] }
  const renderPage = async (source: Source) => {
    db.workspace = workspace(source)
    const ui = await OKRsPage({ params: Promise.resolve({ orgSlug: "acme", workspaceSlug: "alpha" }) })
    return render(withModel(source, <>{ui}</>))
  }

  beforeEach(() => {
    db.cycles = [cycle]
    outcomesIndex.rows = [
      { id: "o1", title: "Persistent goal", status: "ACTIVE", cycle: null, linkedOpportunityCount: 0 },
      { id: "o2", title: "Cycled goal", status: "ACTIVE", cycle: { id: "c1", title: "Q3" }, linkedOpportunityCount: 1 },
    ]
    objectiveCount.mockImplementation(async () => 2)
  })

  it.each([
    ["CLASSIC", CLASSIC],
    ["OPPORTUNITY_FIRST_OKR", OPPORTUNITY_FIRST],
  ])("%s shows the No cycle / Persistent card and no Outcomes index", async (_name, source) => {
    await renderPage(source)
    expect(screen.getAllByTestId("persistent-objectives-card")).toHaveLength(1)
    expect(screen.getByText("No cycle / Persistent")).toBeInTheDocument()
    expect(screen.getByText("2 objectives")).toBeInTheDocument()
    expect(screen.queryByTestId("outcomes-index")).toBeNull()
    expect(screen.queryByTestId("persistent-objectives-link")).toBeNull()
    expect(objectiveCount).toHaveBeenCalledWith({ where: { workspaceId: "w1", cycleId: null } })
  })

  it("TORRES_OST lists the cycle-less Outcome in the index and does not also render the persistent card", async () => {
    await renderPage(TORRES)
    expect(screen.getByTestId("outcomes-index")).toBeInTheDocument()
    expect(screen.getByTestId("outcomes-index-row-o1")).toHaveTextContent("Persistent goal")
    expect(screen.queryByTestId("outcomes-index-cycle-o1")).toBeNull() // a cycle chip only where a cycle exists
    expect(screen.getByTestId("outcomes-index-cycle-o2")).toHaveTextContent("Q3")
    expect(screen.queryByTestId("persistent-objectives-card")).toBeNull()
    expect(screen.queryByText("No cycle / Persistent")).toBeNull()
    expect(objectiveCount).not.toHaveBeenCalled() // no second query for what the index already lists
    // the subdued way into /okrs/none stays reachable
    expect(screen.getByTestId("persistent-objectives-link")).toHaveAttribute("href", "/acme/alpha/okrs/none")
  })

  it("TORRES_OST with only cycle-less Outcomes and no cycles shows the index, not the empty state", async () => {
    db.cycles = []
    await renderPage(TORRES)
    expect(screen.getByTestId("outcomes-index-row-o1")).toBeInTheDocument()
    expect(screen.queryByText(/yet/)).toBeNull()
  })

  it("CLASSIC with only cycle-less Objectives and no cycles shows the card, not the empty state (#332 behavior)", async () => {
    db.cycles = []
    await renderPage(CLASSIC)
    expect(screen.getByTestId("persistent-objectives-card")).toBeInTheDocument()
    expect(screen.queryByText("No OKR cycles yet")).toBeNull()
  })

  it("CLASSIC with nothing at all shows the empty state with #332's link text", async () => {
    db.cycles = []
    objectiveCount.mockImplementation(async () => 0)
    await renderPage(CLASSIC)
    expect(screen.getByText("No OKR cycles yet")).toBeInTheDocument()
    expect(screen.getByTestId("persistent-objectives-link")).toHaveTextContent("Or add an Objective with no cycle (No cycle / Persistent)")
  })

  it("TORRES_OST with nothing at all shows the empty state once, in Outcome words", async () => {
    db.cycles = []
    outcomesIndex.rows = []
    await renderPage(TORRES)
    expect(screen.getAllByTestId("persistent-objectives-link")).toHaveLength(1)
    expect(screen.getByTestId("persistent-objectives-link")).toHaveTextContent("Or add an Outcome with no cycle (No cycle / Persistent)")
  })
})

describe("panels: the Cycle field of a cycle-less Objective", () => {
  const objective = {
    id: "o1",
    title: "Persistent goal",
    description: null,
    status: "ACTIVE",
    owner: null,
    squad: null,
    cycle: null,
    keyResults: [],
    parentKeyResult: null,
    deliveryTasks: [],
    linkableTasks: [],
    members: [],
  }
  const renderObjective = (source: Source, data: Record<string, unknown> = {}) => {
    detail.data = { ...objective, ...data }
    return render(withModel(source, <ObjectivePanel id="o1" orgSlug="acme" workspaceSlug="alpha" />))
  }

  it.each([
    ["CLASSIC", CLASSIC],
    ["OPPORTUNITY_FIRST_OKR", OPPORTUNITY_FIRST],
  ])("%s labels it No cycle / Persistent, as #332 did", (_name, source) => {
    renderObjective(source)
    expect(screen.getByText("Cycle")).toBeInTheDocument()
    expect(screen.getByText("No cycle / Persistent")).toBeInTheDocument()
  })

  it("TORRES_OST says nothing about a missing cycle", () => {
    renderObjective(TORRES)
    expect(screen.queryByText("Cycle")).toBeNull()
    expect(screen.queryByText("No cycle / Persistent")).toBeNull()
  })

  it.each([
    ["CLASSIC", CLASSIC],
    ["TORRES_OST", TORRES],
  ])("%s still shows a real cycle", (_name, source) => {
    renderObjective(source, { cycle: { id: "c1", title: "Q3" } })
    expect(screen.getByText("Cycle")).toBeInTheDocument()
    expect(screen.getByText("Q3")).toBeInTheDocument()
  })

  it("labels the parent KR's cycle-less Objective badge by preset (the field and the badge both say it under CLASSIC)", () => {
    renderObjective(CLASSIC, { parentKeyResult: { id: "k1", title: "KR one", objective: { cycle: null } } })
    expect(screen.getAllByText("No cycle / Persistent")).toHaveLength(2)
  })
})

describe("panels: a Key Result's supporting cycle-less Objective", () => {
  const keyResult = {
    id: "k1",
    title: "Metric",
    current: 1,
    target: 10,
    unit: "",
    objective: null,
    checkIns: [],
    supportingObjectives: [{ id: "s1", title: "Supporter", status: "ACTIVE", cycle: null, owner: null, squad: null, keyResults: [{ current: 5, target: 10 }] }],
    opportunities: [],
    roadmapItems: [],
    deliveryTasks: [],
    linkableTasks: [],
    members: [],
  }
  const renderKr = (source: Source) => {
    detail.data = keyResult
    return render(withModel(source, <KeyResultPanel id="k1" orgSlug="acme" workspaceSlug="alpha" />))
  }

  it("CLASSIC prefixes the progress with No cycle / Persistent, as #332 did", () => {
    renderKr(CLASSIC)
    expect(screen.getByText("No cycle / Persistent · 50%")).toBeInTheDocument()
  })

  it("TORRES_OST shows the progress alone", () => {
    renderKr(TORRES)
    expect(screen.getByText("50%")).toBeInTheDocument()
    expect(screen.queryByText(/No cycle/)).toBeNull()
  })
})
