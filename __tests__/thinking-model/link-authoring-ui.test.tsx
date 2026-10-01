// @vitest-environment jsdom

/**
 * Component-level proof for Phase 4B, per preset: the Solution <-> Key Result picker (Solution panel) and read-only
 * "Linked solutions" list (Key Result panel), the Objective multi-select in the opportunity composer, and the additive
 * linked-Objective marks. CLASSIC / NULL / no-provider renders are byte-identical whether or not the link data is passed:
 * CLASSIC sees no new UI at all. Asserts text and DOM, not layout.
 */
import { type ReactNode } from "react"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { openPanel, link, unlink, refresh, detail, createOpportunityFromComposer, loadOpportunityComposerOptions } = vi.hoisted(() => ({
  openPanel: vi.fn(),
  refresh: vi.fn(),
  link: vi.fn(async (): Promise<{ ok: true; changed: boolean } | { ok: false; error: string; linksUnavailable?: true }> => ({ ok: true, changed: true })),
  unlink: vi.fn(async (): Promise<{ ok: true; changed: boolean } | { ok: false; error: string }> => ({ ok: true, changed: true })),
  detail: { data: {} as Record<string, unknown> },
  createOpportunityFromComposer: vi.fn(),
  loadOpportunityComposerOptions: vi.fn(),
}))

vi.mock("@/auth", () => ({ auth: () => undefined }))
vi.mock("@/lib/db", () => ({ default: () => undefined }))
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/acme/alpha/discovery",
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock("@/components/panels/panel-context", () => ({
  usePanelContext: () => ({ openPanel, closePanel: vi.fn(), notifyEntityMutated: vi.fn(), panel: { type: "opportunity-new", id: "new" } }),
}))
vi.mock("@/components/panels/panel-parts", async (load) => ({
  ...(await load<typeof import("@/components/panels/panel-parts")>()),
  useEntityDetail: () => ({ data: detail.data, error: false, mutate: vi.fn(), refresh }),
}))
vi.mock("@/app/[orgSlug]/[workspaceSlug]/discovery/solution-link-actions", () => ({
  linkSolutionToKeyResultAction: link,
  unlinkSolutionFromKeyResultAction: unlink,
}))
vi.mock("@/app/[orgSlug]/[workspaceSlug]/discovery/actions", () => ({
  saveSolutionScore: vi.fn(),
  createOpportunityFromComposer,
  loadOpportunityComposerOptions,
}))
vi.mock("@/app/[orgSlug]/[workspaceSlug]/roadmap/actions", () => ({ promoteToRoadmap: vi.fn() }))
vi.mock("@/components/comments/discussion", () => ({ Discussion: () => null }))
vi.mock("@/components/decisions/request-decision-link", () => ({ RequestDecisionLink: () => null }))
vi.mock("@/components/tasks/linked-tasks-section", () => ({ LinkedTasksSection: () => null }))
vi.mock("@/components/analytics/measurements-panel", () => ({ MeasurementsPanel: () => null }))
vi.mock("@/components/panels/solution-assumptions", () => ({ SolutionAssumptions: () => null }))
vi.mock("@/components/panels/solution-plan-discussion", () => ({ SolutionPlanDiscussion: () => null }))
vi.mock("@/components/panels/solution-artifacts", () => ({ SolutionArtifacts: () => null }))
vi.mock("@/components/discovery/add-evidence-dialog", () => ({ AddEvidenceDialog: () => null }))
vi.mock("@/components/discovery/evidence-list", () => ({ EvidenceList: () => null }))
vi.mock("@/components/research/flesh-this-out-link", () => ({ FleshThisOutLink: () => null }))
vi.mock("@/components/research/pm-interview-history", () => ({ PmInterviewHistory: () => null }))

import { ThinkingModelProvider } from "@/components/thinking-model/thinking-model-provider"
import { resolveThinkingModel } from "@/lib/thinking-model/resolve"
import { SolutionPanel } from "@/components/panels/solution-panel"
import { KeyResultPanel } from "@/components/panels/key-result-panel"
import { SolutionKeyResultPicker } from "@/components/discovery/solution-key-result-picker"
import { OpportunityComposer } from "@/components/discovery/opportunity-composer"
import { LinkedObjectivesStrip } from "@/components/discovery/linked-objectives-strip"
import { DiscoveryRail } from "@/components/discovery/discovery-rail"
import { OSTTreeView } from "@/components/discovery/ost-tree-view"

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

// React/base-ui generate sequential ids per render; they are not content.
const stableHtml = (el: HTMLElement) => el.innerHTML.replace(/_r_[0-9a-z]+_/g, "_r_")

const withModel = (source: Parameters<typeof resolveThinkingModel>[0], ui: ReactNode) => (
  <ThinkingModelProvider value={resolveThinkingModel(source)}>{ui}</ThinkingModelProvider>
)
const CLASSIC = { thinkingModel: null }
const TORRES = { thinkingModel: "TORRES_OST" }
const OFO = { thinkingModel: "OPPORTUNITY_FIRST_OKR" }

const KEY_RESULTS = [
  { id: "kr-1", title: "Activation to 40%", objectiveTitle: "Grow the base" },
  { id: "kr-2", title: "Churn under 2%", objectiveTitle: "Keep customers" },
]

const solutionData = (extra: Record<string, unknown> = {}) => ({
  id: "sol-1",
  title: "Self-serve export",
  description: null,
  status: "VALIDATED",
  workspaceId: "ws-1",
  opportunity: { id: "opp-1", title: "Exports are manual", squadId: null },
  assumptions: [],
  evidence: [],
  comments: [],
  roadmapItems: [],
  artifacts: [],
  availableArtifacts: [],
  deliveryTasks: [],
  linkableTasks: [],
  members: [],
  pmInterviews: [],
  pmInterviewEnabled: false,
  customFields: [],
  scoringModel: null,
  existingScore: null,
  linkedKeyResults: [],
  ...extra,
})

const keyResultData = (extra: Record<string, unknown> = {}) => ({
  id: "kr-1",
  title: "Activation to 40%",
  current: 1,
  target: 2,
  unit: null,
  objective: { id: "o1", title: "Grow the base", cycleId: "c1" },
  checkIns: [],
  roadmapItems: [],
  opportunities: [],
  supportingObjectives: [],
  deliveryTasks: [],
  linkableTasks: [],
  members: [],
  ...extra,
})

const common = { orgSlug: "acme", workspaceSlug: "alpha" }

describe("Solution panel: Solution <-> Key Result picker", () => {
  const withLinkData = () =>
    solutionData({ linkedKeyResults: [{ id: "kr-1", title: "Activation to 40%", objectiveId: "o1" }], availableKeyResults: KEY_RESULTS })

  it("TORRES_OST: offers the picker in the preset's words (Success metrics), listing the linked ones", () => {
    detail.data = withLinkData()
    render(withModel(TORRES, <SolutionPanel id="sol-1" {...common} />))
    expect(screen.getByText("Linked Success metrics")).toBeInTheDocument()
    const picker = screen.getByTestId("solution-key-result-picker")
    expect(within(picker).getByText("Activation to 40%")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Choose success metrics" })).toBeInTheDocument()
    expect(picker.textContent).not.toMatch(/key result|objective/i)
  })

  it("OPPORTUNITY_FIRST_OKR: offers the picker in Key Result words", () => {
    detail.data = withLinkData()
    render(withModel(OFO, <SolutionPanel id="sol-1" {...common} />))
    expect(screen.getByText("Linked Key Results")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Choose key results" })).toBeInTheDocument()
  })

  it("an override renames the words in the picker", () => {
    detail.data = withLinkData()
    render(
      withModel(
        { ...TORRES, thinkingModelLabels: JSON.stringify({ keyResult: { singular: "Signal", plural: "Signals" } }) },
        <SolutionPanel id="sol-1" {...common} />,
      ),
    )
    expect(screen.getByText("Linked Signals")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Choose signals" })).toBeInTheDocument()
  })

  it("CLASSIC, NULL and no provider: byte-identical render whether or not link data is passed, and no link UI", () => {
    detail.data = solutionData()
    const bare = stableHtml(render(<SolutionPanel id="sol-1" {...common} />).container)
    cleanup()
    detail.data = withLinkData()
    for (const ui of [
      <SolutionPanel key="a" id="sol-1" {...common} />,
      withModel(CLASSIC, <SolutionPanel id="sol-1" {...common} />),
      withModel({}, <SolutionPanel id="sol-1" {...common} />),
      withModel({ thinkingModel: "NOT_A_PRESET" }, <SolutionPanel id="sol-1" {...common} />),
    ]) {
      const { container } = render(ui)
      expect(stableHtml(container)).toBe(bare)
      expect(screen.queryByTestId("solution-key-result-picker")).toBeNull()
      cleanup()
    }
  })

  it("renders no picker when a preset that offers it is handed no options (the fetcher sends none under CLASSIC)", () => {
    detail.data = solutionData()
    render(withModel(TORRES, <SolutionPanel id="sol-1" {...common} />))
    expect(screen.queryByTestId("solution-key-result-picker")).toBeNull()
  })
})

describe("SolutionKeyResultPicker", () => {
  const renderPicker = (props: Partial<React.ComponentProps<typeof SolutionKeyResultPicker>> = {}, source = TORRES) =>
    render(
      withModel(
        source,
        <SolutionKeyResultPicker solutionId="sol-1" linked={[]} available={KEY_RESULTS} onChanged={refresh} {...props} />,
      ),
    )

  it("links a chosen key result through the action with only the two ids (no workspace id), then refreshes", async () => {
    renderPicker()
    expect(screen.getByText("No success metrics linked.")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Choose success metrics" }))
    fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: /Activation to 40%/ }))
    await waitFor(() => expect(link).toHaveBeenCalledWith("sol-1", "kr-1"))
    expect(link.mock.calls[0]).toHaveLength(2)
    await waitFor(() => expect(refresh).toHaveBeenCalled())
    expect(within(screen.getByTestId("solution-key-result-picker")).getAllByText("Activation to 40%").length).toBeGreaterThan(0)
  })

  it("unlinks a linked key result", async () => {
    renderPicker({ linked: [{ id: "kr-1", title: "Activation to 40%" }] })
    fireEvent.click(screen.getByRole("button", { name: "Choose success metrics" }))
    fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: /Activation to 40%/ }))
    await waitFor(() => expect(unlink).toHaveBeenCalledWith("sol-1", "kr-1"))
    await waitFor(() => expect(screen.getByText("No success metrics linked.")).toBeInTheDocument())
  })

  it("shows the action's error and keeps the list unchanged", async () => {
    link.mockResolvedValueOnce({ ok: false, error: "Entity not found or access denied" })
    renderPicker()
    fireEvent.click(screen.getByRole("button", { name: "Choose success metrics" }))
    fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: /Churn under 2%/ }))
    expect(await screen.findByRole("alert")).toHaveTextContent("Entity not found or access denied")
    expect(screen.getByText("No success metrics linked.")).toBeInTheDocument()
    expect(refresh).not.toHaveBeenCalled()
  })

  it("a missing link table (read side) disables changes and says so instead of showing an empty list as fact", () => {
    renderPicker({ linksUnavailable: true })
    expect(screen.getByTestId("solution-links-unavailable")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Choose success metrics" })).toBeNull()
  })

  it("a missing link table (write side) flips the picker read-only after the failed attempt", async () => {
    link.mockResolvedValueOnce({ ok: false, error: "Something went wrong. Please try again.", linksUnavailable: true })
    renderPicker()
    fireEvent.click(screen.getByRole("button", { name: "Choose success metrics" }))
    fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: /Activation to 40%/ }))
    expect(await screen.findByTestId("solution-links-unavailable")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Choose success metrics" })).toBeNull()
  })
})

describe("Key Result panel: Linked solutions", () => {
  it("TORRES_OST and OPPORTUNITY_FIRST_OKR: a read-only list whose rows open the solution's panel", () => {
    for (const source of [TORRES, OFO]) {
      detail.data = keyResultData({ linkedSolutions: [{ id: "sol-1", title: "Self-serve export" }] })
      render(withModel(source, <KeyResultPanel id="kr-1" {...common} />))
      const section = screen.getByTestId("linked-solutions")
      expect(screen.getByText("Linked Solutions")).toBeInTheDocument()
      fireEvent.click(within(section).getByRole("button", { name: /Self-serve export/ }))
      expect(openPanel).toHaveBeenCalledWith("solution", "sol-1")
      expect(within(section).queryByRole("combobox")).toBeNull()
      cleanup()
    }
  })

  it("says so when there are none, and flags unavailable link data instead of an empty list", () => {
    detail.data = keyResultData({ linkedSolutions: [] })
    render(withModel(TORRES, <KeyResultPanel id="kr-1" {...common} />))
    expect(screen.getByText("No solutions linked.")).toBeInTheDocument()
    cleanup()
    detail.data = keyResultData({ linkedSolutions: [], linksUnavailable: true })
    render(withModel(TORRES, <KeyResultPanel id="kr-1" {...common} />))
    expect(screen.getByTestId("linked-solutions-unavailable")).toBeInTheDocument()
    expect(screen.queryByText("No solutions linked.")).toBeNull()
  })

  it("CLASSIC, NULL and no provider: byte-identical render whether or not link data is passed", () => {
    detail.data = keyResultData()
    const bare = stableHtml(render(<KeyResultPanel id="kr-1" {...common} />).container)
    cleanup()
    detail.data = keyResultData({ linkedSolutions: [{ id: "sol-1", title: "Self-serve export" }] })
    for (const ui of [
      <KeyResultPanel key="a" id="kr-1" {...common} />,
      withModel(CLASSIC, <KeyResultPanel id="kr-1" {...common} />),
      withModel({}, <KeyResultPanel id="kr-1" {...common} />),
    ]) {
      const { container } = render(ui)
      expect(stableHtml(container)).toBe(bare)
      expect(screen.queryByTestId("linked-solutions")).toBeNull()
      cleanup()
    }
  })
})

describe("Opportunity composer: optional Objective multi-select", () => {
  const OPTIONS = {
    squads: [],
    keyResults: KEY_RESULTS,
    feedback: [],
    objectives: [
      { id: "obj-1", title: "Grow retention", cycleTitle: "Q3" },
      { id: "obj-2", title: "Cut costs", cycleTitle: null },
    ],
  }
  let store: Map<string, string>

  beforeEach(() => {
    store = new Map()
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, String(v)),
        removeItem: (k: string) => void store.delete(k),
      },
    })
    loadOpportunityComposerOptions.mockResolvedValue({ ok: true, options: OPTIONS })
    createOpportunityFromComposer.mockResolvedValue({ ok: true, opportunity: { id: "opp-9", title: "x" } })
  })

  const mount = async (source?: Parameters<typeof resolveThinkingModel>[0], keyResultName = "Key result") => {
    const ui = <OpportunityComposer orgSlug="acme" workspaceSlug="core" composerId="new" />
    const utils = render(source ? withModel(source, ui) : ui)
    await screen.findByRole("form", { name: "New opportunity" })
    await screen.findByRole("combobox", { name: keyResultName })
    return utils
  }

  it("TORRES_OST: offers Outcomes, and submits the chosen ids with the create", async () => {
    await mount(TORRES, "Success metric")
    const field = await screen.findByTestId("composer-objective-field")
    expect(field).toHaveTextContent("Outcomes")
    expect(field.textContent).not.toMatch(/objective/i)
    fireEvent.click(within(field).getByRole("combobox", { name: "Outcomes" }))
    fireEvent.click(await screen.findByRole("option", { name: "Grow retention" }))
    fireEvent.click(await screen.findByRole("option", { name: "Cut costs" }))
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" })
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Onboarding stalls" } })
    fireEvent.click(screen.getByRole("button", { name: "Submit" }))
    await waitFor(() => expect(createOpportunityFromComposer).toHaveBeenCalled())
    expect(createOpportunityFromComposer.mock.calls[0][2]).toMatchObject({ title: "Onboarding stalls", objectiveIds: ["obj-1", "obj-2"] })
    // The legacy key result pointer is still its own field, and stays unset unless chosen.
    expect(createOpportunityFromComposer.mock.calls[0][2].linkedKeyResultId).toBeNull()
  })

  it("OPPORTUNITY_FIRST_OKR: offers Objectives", async () => {
    await mount(OFO)
    expect(await screen.findByTestId("composer-objective-field")).toHaveTextContent("Objectives")
  })

  it("CLASSIC, NULL and no provider: no Objective field and no objectiveIds in the payload, even if the options carried objectives", async () => {
    for (const source of [undefined, CLASSIC, {}] as const) {
      const { container, unmount } = await mount(source)
      expect(screen.queryByTestId("composer-objective-field")).toBeNull()
      fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Plain" } })
      fireEvent.click(screen.getByRole("button", { name: "Submit" }))
      await waitFor(() => expect(createOpportunityFromComposer).toHaveBeenCalled())
      expect(Object.keys(createOpportunityFromComposer.mock.calls.at(-1)![2]).sort()).toEqual(
        ["customerSegment", "description", "feedbackIds", "linkedKeyResultId", "squadId", "status", "title"].sort(),
      )
      expect(container.innerHTML).not.toMatch(/composer-objective-field/)
      unmount()
      cleanup()
      createOpportunityFromComposer.mockClear()
      store.clear()
    }
  })

  it("CLASSIC render is byte-identical whether or not the options carry objectives", async () => {
    const first = stableHtml((await mount(CLASSIC)).container)
    cleanup()
    loadOpportunityComposerOptions.mockResolvedValue({ ok: true, options: { ...OPTIONS, objectives: undefined } })
    store.clear()
    const second = stableHtml((await mount(CLASSIC)).container)
    expect(second).toBe(first)
  })
})

describe("additive linked-Objective marks", () => {
  const objectives = [{ id: "obj-1", title: "Grow retention" }]

  it("LinkedObjectivesStrip: shown under presets that offer the link, in their words; nothing under CLASSIC or when empty", () => {
    render(withModel(TORRES, <LinkedObjectivesStrip objectives={objectives} />))
    expect(screen.getByTestId("linked-objectives")).toHaveTextContent("Linked outcomes")
    expect(screen.getByText("Grow retention")).toBeInTheDocument()
    cleanup()
    const classic = render(withModel(CLASSIC, <LinkedObjectivesStrip objectives={objectives} />))
    expect(classic.container.innerHTML).toBe("")
    cleanup()
    const empty = render(withModel(TORRES, <LinkedObjectivesStrip objectives={[]} />))
    expect(empty.container.innerHTML).toBe("")
  })

  const railOpp = (extra: Record<string, unknown> = {}) => ({
    id: "opp-1",
    title: "Onboarding confuses people",
    status: "EXPLORING" as const,
    squad: null,
    linkedKeyResultId: null,
    ...extra,
  })

  it("discovery rail: marks an opportunity with linked Objectives under non-CLASSIC; the legacy Key Result mark is unchanged", () => {
    const rail = (opportunity: ReturnType<typeof railOpp>) => (
      <DiscoveryRail variant="panel" opportunities={[opportunity]} orgSlug="acme" workspaceSlug="alpha" />
    )
    render(withModel(TORRES, rail(railOpp({ linkedObjectives: objectives, linkedKeyResultId: "kr-1" }))))
    expect(screen.getByLabelText("Linked to an outcome")).toBeInTheDocument()
    expect(screen.getByLabelText("Linked to a success metric")).toBeInTheDocument()
    cleanup()
    render(withModel(TORRES, rail(railOpp())))
    expect(screen.queryByLabelText("Linked to an outcome")).toBeNull()
  })

  it("discovery rail CLASSIC: byte-identical whether or not linked Objectives are passed", () => {
    const html = (opportunity: ReturnType<typeof railOpp>) =>
      stableHtml(render(withModel(CLASSIC, <DiscoveryRail variant="panel" opportunities={[opportunity]} orgSlug="acme" workspaceSlug="alpha" />)).container)
    const bare = html(railOpp({ linkedKeyResultId: "kr-1" }))
    cleanup()
    expect(html(railOpp({ linkedKeyResultId: "kr-1", linkedObjectives: objectives }))).toBe(bare)
  })

  it("OST tab: shows linked Objectives above the Key Result under non-CLASSIC, and renders exactly the old tree under CLASSIC", () => {
    const opportunity = (extra: Record<string, unknown> = {}) => ({
      id: "opp-1",
      title: "Onboarding",
      status: "EXPLORING" as const,
      linkedKeyResult: { id: "kr-1", title: "Activation", objective: { title: "Grow" } },
      solutions: [],
      ...extra,
    })
    const html = (source: Parameters<typeof resolveThinkingModel>[0], extra?: Record<string, unknown>) =>
      render(withModel(source, <OSTTreeView opportunity={opportunity(extra)} orgSlug="acme" workspaceSlug="alpha" />)).container
    const torres = html(TORRES, { linkedObjectives: objectives })
    expect(within(torres).getByTestId("linked-objectives")).toBeInTheDocument()
    // The legacy Key Result display is kept.
    expect(within(torres).getByText("Activation")).toBeInTheDocument()
    cleanup()
    const bare = stableHtml(html(CLASSIC))
    cleanup()
    expect(stableHtml(html(CLASSIC, { linkedObjectives: objectives }))).toBe(bare)
  })
})
