// @vitest-environment jsdom

/**
 * Phase 4C-2: the surfaces converted in this phase, rendered under the three configurations that matter.
 *
 *  - CLASSIC is pinned elsewhere, byte for byte against origin/main (classic-text.test.tsx, classic-copy-pins.test.ts).
 *    Here it is only a sanity check that the no-provider render equals the explicit CLASSIC render.
 *  - TORRES_OST: Objective -> Outcome and Key Result -> Success metric, the other three names untouched.
 *  - CUSTOM: a workspace that has renamed all five entities. Nothing a user can read on these surfaces may still use a
 *    canonical entity word; only the workspace's own names appear.
 *
 * It renders real components and reads text, placeholders, aria-labels and titles. It is not a visual check.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import type { ReactElement } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"

const noop = vi.hoisted(() => () => undefined)
const actionsProxy = vi.hoisted(
  () => () =>
    new Proxy(
      {},
      {
        get: (_t, key) => (typeof key === "symbol" || key === "then" || key === "__esModule" ? undefined : () => Promise.resolve({ ok: true })),
        has: () => true,
      },
    ),
)

vi.mock("@/auth", () => ({ auth: noop }))
vi.mock("@/lib/db", () => ({ default: noop }))
vi.mock("next/navigation", () => ({
  usePathname: () => "/acme/alpha/okrs",
  useRouter: () => ({ refresh: noop, push: noop, replace: noop }),
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock("@/components/panels/panel-context", () => ({
  usePanelContext: () => ({ openPanel: noop, closePanel: noop, notifyEntityMutated: noop, panel: null }),
}))
vi.mock("@/app/[orgSlug]/[workspaceSlug]/okrs/actions", actionsProxy)
vi.mock("@/app/[orgSlug]/[workspaceSlug]/roadmap/actions", actionsProxy)
vi.mock("@/app/[orgSlug]/[workspaceSlug]/tasks/actions", actionsProxy)
vi.mock("@/app/[orgSlug]/[workspaceSlug]/discovery/actions", actionsProxy)
vi.mock("@/app/[orgSlug]/[workspaceSlug]/discovery/objective-link-actions", actionsProxy)
vi.mock("@/app/[orgSlug]/[workspaceSlug]/discovery/solution-link-actions", actionsProxy)
vi.mock("@/app/[orgSlug]/[workspaceSlug]/settings/actions", actionsProxy)
vi.mock("@/app/[orgSlug]/[workspaceSlug]/settings/custom-field-actions", actionsProxy)
vi.mock("@/app/[orgSlug]/[workspaceSlug]/settings/analytics-actions", actionsProxy)
vi.mock("@/app/[orgSlug]/[workspaceSlug]/reviews/actions", actionsProxy)
vi.mock("@/app/[orgSlug]/[workspaceSlug]/feedback/actions", actionsProxy)
vi.mock("@/app/[orgSlug]/[workspaceSlug]/docs/actions", actionsProxy)
vi.mock("@/lib/actions/auth-actions", actionsProxy)

const entityDetail = vi.hoisted(() => ({ data: null as unknown }))
vi.mock("@/components/panels/panel-parts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/panels/panel-parts")>()),
  useEntityDetail: () => ({ data: entityDetail.data, error: false, mutate: noop, refresh: noop }),
}))

import { ThinkingModelProvider } from "@/components/thinking-model/thinking-model-provider"
import { resolveThinkingModel, type ThinkingModelSource } from "@/lib/thinking-model/resolve"
import type { ResolvedLabels } from "@/lib/thinking-model/labels"
import { NewOpportunityButton } from "@/components/discovery/new-opportunity-button"
import { AddSolutionForm } from "@/components/discovery/add-solution-form"
import { OpportunityCard } from "@/components/discovery/opportunity-card"
import { OpportunityBoard } from "@/components/discovery/opportunity-board"
import { OpportunityFieldBoard } from "@/components/discovery/opportunity-field-board"
import { SolutionBacklogBoard } from "@/components/solutions/solution-backlog-board"
import { DiscoveryTableView } from "@/components/discovery/discovery-table-view"
import { ScoringPanel } from "@/components/discovery/scoring-panel"
import { SolutionScoringPanel } from "@/components/discovery/solution-scoring-panel"
import { OSTTreeView } from "@/components/discovery/ost-tree-view"
import { OpportunityExperimentsTab } from "@/components/discovery/opportunity-experiments-tab"
import { WorkspaceScoringPanel } from "@/components/scoring-models/workspace-scoring-panel"
import { ManageSquadsPanel } from "@/components/squads/manage-squads-panel"
import { DeleteWorkspacePanel } from "@/components/settings/delete-workspace-panel"
import { DecisionSources } from "@/components/decisions/decision-sources"
import { NewDecisionForm } from "@/components/decisions/new-decision-form"
import { NewRoundForm } from "@/components/card-sort/new-round-form"
import { ProposeNewEntryButton } from "@/components/card-sort/card-sort-new-entries"
import { FeedbackActionCell } from "@/components/feedback/feedback-action-cell"
import { UnscheduledItemPreview } from "@/components/roadmap/unscheduled-items-panel"
import { MeasurementsPanel } from "@/components/analytics/measurements-panel"
import { CanvasFlow } from "@/components/canvas/canvas-flow"
import { SolutionPanel } from "@/components/panels/solution-panel"
import { AssumptionPanel } from "@/components/panels/assumption-panel"
import { FeedbackPanel } from "@/components/panels/feedback-panel"
import { BottomNav } from "@/components/bottom-nav"
import { AddObjectiveForm } from "@/components/okrs/add-objective-form"
import { AddKeyResultForm } from "@/components/okrs/add-key-result-form"
import { CreateCycleForm } from "@/components/okrs/create-cycle-form"
import { CycleCard } from "@/components/okrs/cycle-card"
import { AddItemForm } from "@/components/roadmap/add-item-form"
import { LinkTaskDialog } from "@/components/tasks/link-task-dialog"
import { OpportunityOverview } from "@/components/discovery/opportunity-overview"
import { OpportunityHeader } from "@/components/discovery/opportunity-header"
import { ObjectivePanel } from "@/components/panels/objective-panel"
import { KeyResultPanel } from "@/components/panels/key-result-panel"
import { tierLabels } from "@/lib/canvas/tiers"
import { trackedSubjectLabels } from "@/lib/tracked-decision-types"
import { ostLegendRootLabel } from "@/lib/thinking-model/copy"
import { buildCustomFieldFilterGroups } from "@/lib/custom-field-filter"
import { objectTypeLabels } from "@/components/custom-fields/object-type-labels"

afterEach(cleanup)

const common = { orgSlug: "acme", workspaceSlug: "alpha" }
const TORRES: ThinkingModelSource = { thinkingModel: "TORRES_OST" }
const CUSTOM: ThinkingModelSource = {
  thinkingModel: "CLASSIC",
  thinkingModelLabels: JSON.stringify({
    opportunity: { singular: "Problem", plural: "Problems" },
    objective: { singular: "Aim", plural: "Aims" },
    keyResult: { singular: "Signal", plural: "Signals" },
    solution: { singular: "Bet", plural: "Bets" },
    cycle: { singular: "Sprint", plural: "Sprints" },
  }),
}

/** Visible text plus the attributes that carry copy, in document order. */
function copyOf(): string {
  const attrs = [...document.querySelectorAll("[placeholder],[aria-label],[title]")].flatMap((el) =>
    (["placeholder", "aria-label", "title"] as const).flatMap((a) => (el.getAttribute(a) ? [el.getAttribute(a) as string] : [])),
  )
  return [(document.body.textContent ?? "").replace(/\s+/g, " ").trim(), ...attrs].join(" | ")
}

const CANONICAL_WORDS = /\b(opportunit(?:y|ies)|solutions?|objectives?|key results?|krs?|cycles?)\b/i

type Surface = {
  name: string
  /** Server-rendered pieces take the labels as a prop; the rest read them from the provider. */
  ui: (labels: ResolvedLabels) => ReactElement
  interact?: () => void
  /** What a CUSTOM workspace must read. */
  custom: string[]
  /** What TORRES must read (the surface names Objective or Key Result), if anything. */
  torres?: string[]
  /** Canonical words that stay on a CUSTOM surface because they are not entity names (rare, named here). */
  keepsCanonical?: RegExp
}

const click = (name: string | RegExp) => () => fireEvent.click(screen.getByRole("button", { name }))

const scoringModel = {
  id: "m1", name: "RICE", description: null, status: "ACTIVE", formulaType: "WEIGHTED", version: 3,
  metrics: [{ id: "x1", key: "reach", label: "Reach", description: null, minValue: 1, maxValue: 10, weight: 1, direction: "HIGHER_IS_BETTER", order: 0 }],
} as never
const staleScore = {
  id: "s1", scoringModelId: "m1", scoringModelName: "RICE", modelVersion: 2, formulaType: "WEIGHTED", formulaSnapshot: [],
  rawValues: { reach: 5 }, rawScore: 5, normalizedScore: 50, scoredAt: "2026-01-01T12:00:00Z", stale: true,
} as never
const oppCard = (solutions: number) => ({ id: "o1", title: "Need", customerSegment: null, status: "EXPLORING" as const, sortOrder: 0, _count: { solutions, evidence: 0 } })
const solCard = { id: "s1", title: "Fix", description: null, status: "IDEA" as const, sortOrder: 0, _count: { assumptions: 1, evidence: 0 } }

const SURFACES: Surface[] = [
  { name: "new-opportunity-button column", ui: () => <NewOpportunityButton variant="column" status={"EXPLORING" as never} />, custom: ["Add problem"] },
  { name: "new-opportunity-button rail", ui: () => <NewOpportunityButton variant="rail" />, custom: ["New Problem"] },
  {
    name: "add-solution open",
    ui: () => <AddSolutionForm opportunityId="o1" revalidatePathStr="/x" />,
    interact: click(/add .*/i),
    custom: ["New Bet", "Bet title", "Describe the bet approach..."],
  },
  { name: "opportunity-card", ui: () => <OpportunityCard opportunity={oppCard(3)} {...common} />, custom: ["3 bets"] },
  {
    name: "opportunity-board empty",
    ui: () => <OpportunityBoard opportunitiesByStatus={{ EXPLORING: [], VALIDATING: [], PRIORITIZED: [], ACTIVE: [], ARCHIVED: [] }} workspaceId="w1" {...common} />,
    custom: ["No problems yet", "Problem board", "Add problem"],
  },
  {
    name: "opportunity-field-board",
    ui: () => (
      <OpportunityFieldBoard
        field={{ id: "f1", name: "Area", options: [{ value: "a", label: "A" } as never] }}
        opportunities={[{ id: "o1", title: "Need", customerSegment: null, _count: { solutions: 2, evidence: 0 }, value: "a" }]}
        workspaceId="w1"
        {...common}
      />
    ),
    custom: ["Problem board grouped by Area", "2 bets", "1 problem"],
  },
  { name: "solution-backlog empty", ui: () => <SolutionBacklogBoard solutions={[]} workspaceId="w1" {...common} />, custom: ["No bets found", "Bets are added from problem pages in Discovery. Or adjust the filters."] },
  {
    name: "solution-backlog items",
    ui: () => <SolutionBacklogBoard solutions={[{ ...solCard, opportunity: { id: "o1", title: "Need", squad: null } }]} workspaceId="w1" {...common} />,
    custom: ["No bets", "Bet backlog"],
  },
  { name: "discovery-table empty", ui: () => <DiscoveryTableView opportunities={[]} />, custom: ["No problems match the current filters."] },
  {
    name: "discovery-table rows",
    ui: () => (
      <DiscoveryTableView
        opportunities={[
          {
            id: "o1", title: "Need", customerSegment: null, status: "EXPLORING", sortOrder: 0, squad: null, evidenceCount: 0,
            solutions: [{ id: "s1", title: "Fix", status: "IDEA", sortOrder: 0, evidenceCount: 0, assumptionCount: 2 }],
          },
        ]}
      />
    ),
    custom: ["Discovery problems", "1 bet"],
  },
  { name: "scoring-panel stale", ui: () => <ScoringPanel opportunityId="o1" revalidatePathStr="/x" scoringModel={scoringModel} existingScore={staleScore} {...common} />, custom: ["This problem was scored under an earlier version"] },
  { name: "solution-scoring-panel stale", ui: () => <SolutionScoringPanel solutionId="s1" revalidatePathStr="/x" scoringModel={scoringModel} existingScore={staleScore} {...common} />, custom: ["This bet was scored under an earlier version"] },
  {
    name: "ost-tree",
    ui: () => (
      <OSTTreeView
        opportunity={{ id: "o1", title: "Need", status: "EXPLORING", linkedKeyResult: { id: "k1", title: "Reach", objective: { title: "Grow" } }, solutions: [] }}
        {...common}
      />
    ),
    custom: ["Signal", "Problem", "Bet", "No bets yet"],
    torres: ["Success metric", "Opportunity", "Solution", "No solutions yet"],
  },
  { name: "experiments-tab empty", ui: () => <OpportunityExperimentsTab experiments={[]} {...common} />, custom: ["Add assumptions to bets and link experiments to them."] },
  { name: "workspace-scoring solution", ui: () => <WorkspaceScoringPanel entityType={"SOLUTION" as never} availableModels={[{ id: "m1", name: "RICE", formulaType: "WEIGHTED" }]} currentScoringModelId="m1" {...common} />, custom: ["Active scoring model for Bets", "Bets in this workspace"] },
  { name: "workspace-scoring opportunity", ui: () => <WorkspaceScoringPanel entityType={"OPPORTUNITY" as never} availableModels={[{ id: "m1", name: "RICE", formulaType: "WEIGHTED" }]} currentScoringModelId="m1" {...common} />, custom: ["Problems in this workspace"] },
  {
    name: "manage-squads empty",
    ui: () => <ManageSquadsPanel initialSquads={[]} {...common} />,
    custom: ["across problems, experiments, and aims."],
    torres: ["across opportunities, experiments, and outcomes."],
  },
  {
    name: "delete-workspace open",
    ui: () => <DeleteWorkspacePanel workspaceName="Alpha" {...common} />,
    interact: click(/delete workspace/i),
    custom: ["including OKRs, problems, experiments"],
    torres: ["including Outcomes, opportunities, experiments"],
  },
  {
    name: "decision-sources",
    ui: (labels) => <DecisionSources entity={{ type: "OPPORTUNITY", id: "o1", title: "Need" } as never} sources={[{ type: "SOLUTION", id: "s1", title: "Fix", updatedAt: "2026-01-01T12:00:00Z" } as never]} labels={labels} {...common} />,
    custom: ["Problem", "Bet"],
  },
  {
    name: "new-decision-form",
    ui: () => <NewDecisionForm workspaceId="w1" subjects={[{ type: "WORKSPACE", id: "w1", title: "Alpha" }]} {...common} />,
    custom: ["Problem", "Bet"],
  },
  { name: "new-round-form empty", ui: () => <NewRoundForm factors={[]} {...common} />, custom: ["no SELECT custom fields on problems"] },
  {
    name: "propose-new-entry open",
    ui: () => <ProposeNewEntryButton roundId="r1" options={[]} {...common} />,
    interact: click(/propose new entry/i),
    custom: ["Propose a new problem", "not problem yet"],
  },
  {
    name: "feedback-action-cell",
    ui: () => (
      <FeedbackActionCell
        row={{ id: "f1", title: "Slow", description: null, submitterName: null, submitterEmail: null, status: "NEW", voteCount: 0, type: "IDEA", opportunityId: null, roadmapItem: null, createdAt: "2026-01-01T12:00:00Z", attachments: [] } as never}
        opportunities={[{ id: "o1", title: "Need" }]}
        workspaceId="w1"
        roadmapPath="/acme/alpha/roadmap"
        {...common}
      />
    ),
    custom: ["Link Slow to problem", "Link problem"],
  },
  { name: "unscheduled solution", ui: () => <UnscheduledItemPreview item={{ kind: "solution", id: "s1", title: "Fix", opportunityId: "o1", opportunityTitle: "Need", squadId: null }} />, custom: ["Bet"] },
  {
    name: "measurements-panel",
    ui: () => <MeasurementsPanel target={{ targetType: "KEY_RESULT", targetId: "k1" } as never} {...common} />,
    custom: ["or signal update."],
    torres: ["or success metric update."],
  },
  {
    name: "canvas empty",
    ui: () => <CanvasFlow overview={{ objectives: [], keyResults: [], opportunities: [], solutions: [], assumptions: [], experiments: [], roadmapItems: [], links: { opportunityObjective: [], solutionKeyResult: [] } } as never} />,
    custom: ["Add Aims and Signals from the OKRs page to see them here."],
    torres: ["Add Outcomes and Success metrics from the Outcomes page to see them here."],
  },
]

const cycleRow = { id: "c1", title: "Q3", startDate: new Date("2026-07-01T12:00:00Z"), endDate: new Date("2026-09-30T12:00:00Z"), status: "ACTIVE" as const }
const kr = { id: "k1", title: "Reach", objective: { title: "Grow" }, current: 1, target: 2, unit: null }
const noLinks = { OPPORTUNITY: [], SOLUTION: [], ROADMAP_ITEM: [], OBJECTIVE: [], KEY_RESULT: [], DOC: [], EXPERIMENT: [], FEEDBACK_ITEM: [], DECISION: [] }

/** Surfaces converted earlier (Phase 3B/3C/4B/4C-1), now also under overrides of Opportunity, Solution and Cycle. */
const EARLIER: Surface[] = [
  { name: "bottom-nav", ui: () => <BottomNav {...common} />, custom: [] },
  { name: "add-objective", ui: () => <AddObjectiveForm cycleId="c1" {...common} />, interact: click(/add /i), custom: ["Add Aim"] },
  { name: "add-key-result", ui: () => <AddKeyResultForm objectiveId="o1" objectiveTitle="Grow" {...common} />, interact: click(/add /i), custom: ["Add Signal", "Signal"] },
  { name: "create-cycle open", ui: () => <CreateCycleForm workspaceId="w1" {...common} />, interact: click(/new /i), custom: ["New OKR Sprint", "Create sprint"] },
  { name: "cycle-card", ui: () => <CycleCard cycle={{ ...cycleRow, _count: { objectives: 2 } }} {...common} />, custom: ["2 aims"] },
  {
    name: "roadmap add-item",
    ui: () => (
      <AddItemForm
        workspaceId="w1" horizon={"NOW" as never} revalidatePathStr="/x"
        availableKRs={[{ id: "k", title: "KR one", objectiveTitle: "Obj" }]}
        availableSolutions={[{ id: "s", title: "Sol", opportunityTitle: "Opp" }]}
        availableOpportunities={[{ id: "o", title: "Opp" }]}
        availableExperiments={[{ id: "e", title: "Exp", status: "RUNNING" }]}
      />
    ),
    interact: click(/add/i),
    custom: ["Problem (optional)", "Signal (optional)", "Bet (optional)"],
  },
  { name: "link-task-dialog", ui: () => <LinkTaskDialog taskId="t" open onOpenChange={noop} revalidatePathStr="/x" linkableTargets={{ ...noLinks, OBJECTIVE: [{ id: "o1", title: "Grow" }], OPPORTUNITY: [{ id: "p1", title: "Need" }] } as never} onLinked={noop} />, custom: ["Problems", "Bets"] },
  {
    name: "opportunity-overview",
    ui: () => <OpportunityOverview opportunity={{ id: "o", title: "Opp", description: null, customerSegment: null, status: "EXPLORING", createdAt: new Date("2026-01-15T12:00:00Z"), linkedKeyResult: kr } as never} revalidatePathStr="/x" availableKeyResults={[{ id: "k1", title: "Reach", objectiveTitle: "Grow" }]} />,
    custom: ["Linked Signal"],
  },
  {
    name: "opportunity-header unlinked",
    ui: () => <OpportunityHeader opportunity={{ id: "o", title: "Opp", description: null, customerSegment: null, status: "EXPLORING", squadId: null, linkedKeyResult: null } as never} availableKeyResults={[{ id: "k1", title: "Reach", objectiveTitle: "Grow" }]} squads={[]} revalidatePathStr="/x" />,
    custom: ["No signal linked.", "Link to signal"],
  },
]

const PANELS: Array<{ name: string; data: unknown; ui: (labels: ResolvedLabels) => ReactElement; custom: string[] }> = [
  {
    name: "solution-panel",
    data: {
      id: "s1", pmInterviews: [], title: "Fix", description: null, status: "IDEA", workspaceId: "w1",
      opportunity: null, assumptions: [], evidence: [], comments: [], roadmapItems: [],
      artifacts: [], availableArtifacts: [], deliveryTasks: [], linkableTasks: [], members: [], customFields: [], scoringModel: null, existingScore: null,
    },
    ui: () => <SolutionPanel id="s1" {...common} />,
    custom: ["Problem"],
  },
  {
    name: "assumption-panel",
    data: { id: "a1", pmInterviews: [], title: "Risky", description: null, riskLevel: "HIGH", status: "UNTESTED", solution: { id: "s1", title: "Fix", opportunity: { id: "o1", title: "Need" } }, experiments: [] },
    ui: () => <AssumptionPanel id="a1" {...common} />,
    custom: ["Bet"],
  },
  {
    name: "feedback-panel",
    data: { id: "f1", title: "Slow", description: null, type: "IDEA", status: "NEW", voteCount: 0, submitterName: null, opportunity: null, attachments: [], _count: { votes: 0 }, deliveryTasks: [], linkableTasks: [], members: [] },
    ui: () => <FeedbackPanel id="f1" {...common} />,
    custom: ["Linked Problem", "Not linked to problem."],
  },
]

const under = (source: ThinkingModelSource | null, ui: ReactElement) =>
  source ? <ThinkingModelProvider value={resolveThinkingModel(source)}>{ui}</ThinkingModelProvider> : ui

function textFor(source: ThinkingModelSource | null, make: (labels: ResolvedLabels) => ReactElement, interact?: () => void): string {
  const view = render(under(source, make(resolveThinkingModel(source ?? {}).labels)))
  interact?.()
  const text = copyOf()
  view.unmount()
  cleanup()
  return text
}

describe("a workspace that renamed all five entities sees only its own names", () => {
  it.each(SURFACES)("$name", ({ ui, interact, custom, keepsCanonical }) => {
    const text = textFor(CUSTOM, ui, interact)
    for (const phrase of custom) expect(text, `missing ${JSON.stringify(phrase)}`).toContain(phrase)
    const canonical = [...text.matchAll(new RegExp(CANONICAL_WORDS.source, "gi"))].map((m) => m[0]).filter((word) => !keepsCanonical?.test(word))
    expect(canonical, `canonical entity words left in: ${text}`).toEqual([])
  })

  it.each(PANELS)("$name", ({ data, ui, custom }) => {
    entityDetail.data = data
    const text = textFor(CUSTOM, ui)
    for (const phrase of custom) expect(text, `missing ${JSON.stringify(phrase)}`).toContain(phrase)
    expect([...text.matchAll(new RegExp(CANONICAL_WORDS.source, "gi"))].map((m) => m[0])).toEqual([])
  })
})

describe("surfaces converted earlier also follow Opportunity, Solution and Cycle overrides", () => {
  it.each(EARLIER)("$name", ({ ui, interact, custom }) => {
    const text = textFor(CUSTOM, ui, interact)
    for (const phrase of custom) expect(text, `missing ${JSON.stringify(phrase)}`).toContain(phrase)
    expect([...text.matchAll(new RegExp(CANONICAL_WORDS.source, "gi"))].map((m) => m[0]), text).toEqual([])
  })

  it("the objective and key-result panels", () => {
    entityDetail.data = {
      id: "o1", title: "Grow", description: null, owner: "Me", status: "ON_TRACK", cycle: { id: "c1", title: "Q3" }, squad: null,
      keyResults: [{ id: "k1", title: "Reach", current: 1, target: 2, unit: null }],
      parentKeyResult: null, deliveryTasks: [], linkableTasks: [], members: [],
    }
    const objective = textFor(CUSTOM, () => <ObjectivePanel id="o1" {...common} />)
    expect(objective).toContain("Signals (1)")
    expect(objective).toContain("Sprint")
    expect(objective).not.toMatch(CANONICAL_WORDS)
    entityDetail.data = {
      id: "k1", title: "Reach", current: 1, target: 2, unit: null, objective: { id: "o1", title: "Grow", cycleId: "c1" },
      supportingObjectives: [], opportunities: [{ id: "p1", title: "Need" }], roadmapItems: [], deliveryTasks: [], linkableTasks: [], members: [],
    }
    const keyResult = textFor(CUSTOM, () => <KeyResultPanel id="k1" {...common} />)
    expect(keyResult).toContain("Linked Problems (1)")
    expect(keyResult).not.toMatch(CANONICAL_WORDS)
  })
})

describe("TORRES_OST renames Objective and Key Result across these surfaces and leaves the other three alone", () => {
  it.each(SURFACES.filter((s) => s.torres))("$name", ({ ui, interact, torres }) => {
    const text = textFor(TORRES, ui, interact)
    for (const phrase of torres ?? []) expect(text, `missing ${JSON.stringify(phrase)}`).toContain(phrase)
    expect(text).not.toMatch(/\b(objectives?|key results?)\b/i)
  })

  it("every surface is unchanged for the three entities Torres does not rename", () => {
    for (const surface of SURFACES.filter((s) => !s.torres)) {
      expect(textFor(TORRES, surface.ui, surface.interact), surface.name).toBe(textFor(null, surface.ui, surface.interact))
    }
  })
})

describe("no provider (portal, help, embed) and explicit CLASSIC render the same copy", () => {
  it.each(SURFACES)("$name", ({ ui, interact }) => {
    expect(textFor({ thinkingModel: "CLASSIC" }, ui, interact)).toBe(textFor(null, ui, interact))
    expect(textFor({ thinkingModel: null }, ui, interact)).toBe(textFor(null, ui, interact))
  })
})

describe("helpers that build copy outside components", () => {
  const labels = (source: ThinkingModelSource) => resolveThinkingModel(source).labels

  it("canvas tier names", () => {
    expect(tierLabels(labels({})).T1).toBe("Cycle")
    expect(tierLabels(labels(CUSTOM)).T1).toBe("Sprint")
  })

  it("tracked decision subject names: only the two entities are renamed", () => {
    expect(trackedSubjectLabels(labels({}))).toMatchObject({ OPPORTUNITY: "Opportunity", SOLUTION: "Solution", ROADMAP_ITEM: "Roadmap Item" })
    expect(trackedSubjectLabels(labels(CUSTOM))).toMatchObject({ OPPORTUNITY: "Problem", SOLUTION: "Bet", ROADMAP_ITEM: "Roadmap Item", DOC: "Doc" })
  })

  it("the tree legend keeps today's 'Outcome' only while Key Result keeps its name", () => {
    expect(ostLegendRootLabel(labels({}))).toBe("Outcome")
    expect(ostLegendRootLabel(labels(TORRES))).toBe("Success metric")
    expect(ostLegendRootLabel(labels(CUSTOM))).toBe("Signal")
    expect(ostLegendRootLabel(labels({ thinkingModel: "OPPORTUNITY_FIRST_OKR" }))).toBe("Outcome")
  })

  it("custom field filter suffix", () => {
    const field = { id: "a", name: "Area", objectType: "OPPORTUNITY", fieldType: "SELECT", options: [{ value: "x", label: "X" }], sharedOptionSetId: null, sharedOptionSetName: null, required: false, order: 0 } as never
    const groups = buildCustomFieldFilterGroups([field, { ...(field as object), id: "b", objectType: "SOLUTION" } as never], objectTypeLabels(labels(CUSTOM)))
    expect(groups.map((g) => g.label)).toEqual(["Area (Problem)", "Area (Bet)"])
  })
})
