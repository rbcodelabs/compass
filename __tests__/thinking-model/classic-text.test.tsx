// @vitest-environment jsdom

/**
 * Pins the exact user-visible text of the converted components under CLASSIC.
 *
 * The expected text lives in classic-text.snapshot.json and was GENERATED FROM
 * origin/main's components, not from this branch: run this file with
 * WRITE_CLASSIC_SNAPSHOT=1 inside a checkout of main (this harness imports nothing
 * from lib/thinking-model, so it runs unchanged there). On a branch it only
 * compares. A converted component that renders different text with no provider
 * (CLASSIC / NULL) fails here with the old and new strings side by side.
 *
 * It renders text, placeholders, aria-labels and titles. It does not see content
 * inside closed menus or popups, and it is not a visual check.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { ReactElement } from "react"
import { afterAll, afterEach, describe, expect, it, vi } from "vitest"

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

import { BottomNav } from "@/components/bottom-nav"
import { AddObjectiveForm } from "@/components/okrs/add-objective-form"
import { AddKeyResultForm } from "@/components/okrs/add-key-result-form"
import { CreateCycleForm } from "@/components/okrs/create-cycle-form"
import { CycleCard } from "@/components/okrs/cycle-card"
import { AddItemForm } from "@/components/roadmap/add-item-form"
import { EditItemDialog } from "@/components/roadmap/edit-item-dialog"
import { LinkTaskDialog } from "@/components/tasks/link-task-dialog"
import { TaskLinksPanel } from "@/components/tasks/task-links-panel"
import { ManageFieldsPanel } from "@/components/custom-fields/manage-fields-panel"
import { SharedOptionSetsPanel } from "@/components/custom-fields/shared-option-sets-panel"
import { OpportunityOverview } from "@/components/discovery/opportunity-overview"
import { OpportunityHeader } from "@/components/discovery/opportunity-header"
import { ObjectivePanel } from "@/components/panels/objective-panel"
import { KeyResultPanel } from "@/components/panels/key-result-panel"
import { NewOpportunityButton } from "@/components/discovery/new-opportunity-button"
import { AddSolutionForm } from "@/components/discovery/add-solution-form"
import { OpportunityCard } from "@/components/discovery/opportunity-card"
import { OpportunityBoard } from "@/components/discovery/opportunity-board"
import { OpportunityFieldBoard } from "@/components/discovery/opportunity-field-board"
import { SolutionSwimlaneBoard } from "@/components/discovery/solution-swimlane-board"
import { DiscoveryTableView } from "@/components/discovery/discovery-table-view"
import { ScoringPanel } from "@/components/discovery/scoring-panel"
import { SolutionScoringPanel } from "@/components/discovery/solution-scoring-panel"
import { SolutionsList } from "@/components/discovery/solutions-list"
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

const SNAPSHOT = path.join(process.cwd(), "__tests__/thinking-model/classic-text.snapshot.json")
const WRITE = process.env.WRITE_CLASSIC_SNAPSHOT === "1"
const recorded: Record<string, string> = {}
const expected: Record<string, string> = !WRITE && existsSync(SNAPSHOT) ? JSON.parse(readFileSync(SNAPSHOT, "utf-8")) : {}

/** Visible text plus the attributes that carry copy, in document order. */
function copyOf(container: HTMLElement): string {
  const attrs = [...container.ownerDocument.querySelectorAll("[placeholder],[aria-label],[title]")].flatMap((el) =>
    (["placeholder", "aria-label", "title"] as const).flatMap((a) => (el.getAttribute(a) ? [`${a}=${el.getAttribute(a)}`] : [])),
  )
  const text = (container.ownerDocument.body.textContent ?? "").replace(/\s+/g, " ").trim()
  return [text, ...attrs].join(" | ")
}

afterEach(cleanup)
afterAll(() => {
  if (WRITE) writeFileSync(SNAPSHOT, JSON.stringify(recorded, null, 2) + "\n")
})

function check(name: string, ui: ReactElement, interact?: () => void) {
  it(name, () => {
    const { container } = render(ui)
    interact?.()
    const actual = copyOf(container)
    recorded[name] = actual
    if (!WRITE) expect(actual).toBe(expected[name])
  })
}

const click = (name: string | RegExp) => () => fireEvent.click(screen.getByRole("button", { name }))
// Midday UTC so the rendered date does not depend on the machine's time zone.
const cycle = { id: "c1", title: "Q3", startDate: new Date("2026-07-01T12:00:00Z"), endDate: new Date("2026-09-30T12:00:00Z"), status: "ACTIVE" as const }
const common = { orgSlug: "acme", workspaceSlug: "alpha" }

describe("CLASSIC text is identical to main", () => {
  check("bottom-nav", <BottomNav {...common} />)
  check("add-objective closed", <AddObjectiveForm cycleId="c1" {...common} />)
  check("add-objective open", <AddObjectiveForm cycleId="c1" {...common} />, click("Add objective"))
  check("add-key-result closed", <AddKeyResultForm objectiveId="o1" objectiveTitle="Grow" {...common} />)
  check("add-key-result open", <AddKeyResultForm objectiveId="o1" objectiveTitle="Grow" {...common} />, click("Add key result"))
  check("create-cycle closed", <CreateCycleForm workspaceId="w1" {...common} />)
  check("create-cycle open", <CreateCycleForm workspaceId="w1" {...common} />, click("New Cycle"))
  check("cycle-card 0", <CycleCard cycle={{ ...cycle, _count: { objectives: 0 } }} {...common} />)
  check("cycle-card 1", <CycleCard cycle={{ ...cycle, _count: { objectives: 1 } }} {...common} />)
  check("cycle-card 3", <CycleCard cycle={{ ...cycle, _count: { objectives: 3 } }} {...common} />)
  check(
    "roadmap add-item open",
    <AddItemForm
      workspaceId="w1"
      horizon={"NOW" as never}
      revalidatePathStr="/x"
      availableKRs={[{ id: "k", title: "KR one", objectiveTitle: "Obj" }]}
      availableSolutions={[{ id: "s", title: "Sol", opportunityTitle: "Opp" }]}
      availableOpportunities={[{ id: "o", title: "Opp" }]}
      availableExperiments={[{ id: "e", title: "Exp", status: "RUNNING" }]}
    />,
    click(/add/i),
  )
  check(
    "roadmap edit-item",
    <EditItemDialog
      item={{ id: "r1", title: "Item", description: null, startDate: null, endDate: null, isPrivate: false, opportunityId: null, opportunity: null } as never}
      workspaceId="w1"
      open
      onOpenChange={noop}
      revalidatePathStr="/x"
      onSaved={noop}
      availableOpportunities={[{ id: "o", title: "Opp" }]}
    />,
  )
  const empty = { OPPORTUNITY: [], SOLUTION: [], ROADMAP_ITEM: [], OBJECTIVE: [], KEY_RESULT: [], DOC: [], EXPERIMENT: [], FEEDBACK_ITEM: [], DECISION: [] }
  const one = { ...empty, OBJECTIVE: [{ id: "o1", title: "Grow" }], KEY_RESULT: [{ id: "k1", title: "Reach" }], OPPORTUNITY: [{ id: "p1", title: "Need" }] }
  check("link-task-dialog", <LinkTaskDialog taskId="t" open onOpenChange={noop} revalidatePathStr="/x" linkableTargets={one} onLinked={noop} />)
  check(
    "task-links-panel",
    <TaskLinksPanel
      taskId="t"
      initialLinks={
        [
          { id: "l1", linkedType: "OBJECTIVE", linkedId: "o1", title: "Grow" },
          { id: "l2", linkedType: "KEY_RESULT", linkedId: "k1", title: "Reach" },
          { id: "l3", linkedType: "OPPORTUNITY", linkedId: "p1", title: "Need" },
          { id: "l4", linkedType: "SOLUTION", linkedId: "s1", title: "Fix" },
        ] as never
      }
      revalidatePathStr="/x"
      linkableTargets={one}
      {...common}
    />,
  )
  check("manage-fields", <ManageFieldsPanel {...common} initialFields={[]} sharedOptionSets={[]} />)
  check(
    "shared-option-sets",
    <SharedOptionSetsPanel
      {...common}
      sets={[{ id: "s1", name: "Area", options: [], fieldCount: 1, usedBy: [{ id: "f1", name: "Field", objectType: "OBJECTIVE" }] }] as never}
    />,
  )
  const kr = { id: "k1", title: "Reach", objective: { title: "Grow" }, current: 1, target: 2, unit: null }
  check(
    "opportunity-overview",
    <OpportunityOverview
      opportunity={{ id: "o", title: "Opp", description: null, customerSegment: null, status: "EXPLORING", createdAt: new Date("2026-01-15T12:00:00Z"), linkedKeyResult: kr }}
      revalidatePathStr="/x"
      availableKeyResults={[{ id: "k1", title: "Reach", objectiveTitle: "Grow" }]}
    />,
  )
  check(
    "opportunity-header linked",
    <OpportunityHeader
      opportunity={{ id: "o", title: "Opp", description: null, customerSegment: null, status: "EXPLORING", squadId: null, linkedKeyResult: kr }}
      availableKeyResults={[{ id: "k1", title: "Reach", objectiveTitle: "Grow" }]}
      squads={[]}
      revalidatePathStr="/x"
    />,
  )
  check(
    "opportunity-header unlinked",
    <OpportunityHeader
      opportunity={{ id: "o", title: "Opp", description: null, customerSegment: null, status: "EXPLORING", squadId: null, linkedKeyResult: null }}
      availableKeyResults={[{ id: "k1", title: "Reach", objectiveTitle: "Grow" }]}
      squads={[]}
      revalidatePathStr="/x"
    />,
  )
  it("objective-panel", () => {
    entityDetail.data = {
      id: "o1", title: "Grow", description: null, owner: "Me", status: "ON_TRACK", cycle: { id: "c1", title: "Q3" }, squad: null,
      keyResults: [{ id: "k1", title: "Reach", current: 1, target: 2, unit: null }],
      parentKeyResult: { id: "k9", title: "Parent", objective: { id: "o9", title: "P", cycle: { id: "c0", title: "Y", status: "ACTIVE" } } },
      deliveryTasks: [], linkableTasks: [], members: [],
    }
    const { container } = render(<ObjectivePanel id="o1" {...common} />)
    const actual = copyOf(container)
    recorded["objective-panel"] = actual
    if (!WRITE) expect(actual).toBe(expected["objective-panel"])
  })
  it("key-result-panel", () => {
    entityDetail.data = {
      id: "k1", title: "Reach", current: 1, target: 2, unit: null, objective: { id: "o1", title: "Grow", cycleId: "c1" },
      supportingObjectives: [{ id: "o2", title: "Support", cycle: { id: "c2", title: "Q4" }, keyResults: [], squad: null }],
      opportunities: [{ id: "p1", title: "Need" }], roadmapItems: [], deliveryTasks: [], linkableTasks: [], members: [],
    }
    const { container } = render(<KeyResultPanel id="k1" {...common} />)
    const actual = copyOf(container)
    recorded["key-result-panel"] = actual
    if (!WRITE) expect(actual).toBe(expected["key-result-panel"])
  })
})

// Phase 4C-2: the remaining converted surfaces. Same rule as above: the expected text comes from origin/main.
describe("CLASSIC text is identical to main (Phase 4C-2 surfaces)", () => {
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
  const lane = { id: "o1", title: "Need", squad: null, solutions: [solCard] }

  check("new-opportunity-button column", <NewOpportunityButton variant="column" status={"EXPLORING" as never} />)
  check("new-opportunity-button rail", <NewOpportunityButton variant="rail" />)
  check("add-solution closed", <AddSolutionForm opportunityId="o1" revalidatePathStr="/x" />)
  check("add-solution open", <AddSolutionForm opportunityId="o1" revalidatePathStr="/x" />, click("Add Solution"))
  check("opportunity-card 1", <OpportunityCard opportunity={oppCard(1)} {...common} />)
  check("opportunity-card 3", <OpportunityCard opportunity={oppCard(3)} {...common} />)
  check(
    "opportunity-board empty",
    <OpportunityBoard opportunitiesByStatus={{ EXPLORING: [], VALIDATING: [], PRIORITIZED: [], ACTIVE: [], ARCHIVED: [] }} workspaceId="w1" {...common} />,
  )
  check(
    "opportunity-field-board",
    <OpportunityFieldBoard
      field={{ id: "f1", name: "Area", options: [{ value: "a", label: "A" } as never] }}
      opportunities={[{ id: "o1", title: "Need", customerSegment: null, _count: { solutions: 2, evidence: 0 }, value: "a" }]}
      workspaceId="w1"
      {...common}
    />,
  )
  check("swimlane empty", <SolutionSwimlaneBoard opportunities={[]} workspaceId="w1" {...common} />)
  check("swimlane lane", <SolutionSwimlaneBoard opportunities={[lane]} workspaceId="w1" {...common} />)
  check("discovery-table empty", <DiscoveryTableView opportunities={[]} />)
  check(
    "discovery-table rows",
    <DiscoveryTableView
      opportunities={[
        {
          id: "o1", title: "Need", customerSegment: null, status: "EXPLORING", sortOrder: 0, squad: null, evidenceCount: 0,
          solutions: [{ id: "s1", title: "Fix", status: "IDEA", sortOrder: 0, evidenceCount: 0, assumptionCount: 2 }],
        },
      ]}
    />,
  )
  check("scoring-panel stale", <ScoringPanel opportunityId="o1" revalidatePathStr="/x" scoringModel={scoringModel} existingScore={staleScore} {...common} />)
  check("solution-scoring-panel stale", <SolutionScoringPanel solutionId="s1" revalidatePathStr="/x" scoringModel={scoringModel} existingScore={staleScore} {...common} />)
  check("solutions-list", <SolutionsList solutions={[solCard]} revalidatePathStr="/x" />)
  check(
    "ost-tree linked",
    <OSTTreeView
      opportunity={{ id: "o1", title: "Need", status: "EXPLORING", linkedKeyResult: { id: "k1", title: "Reach", objective: { title: "Grow" } }, solutions: [] }}
      {...common}
    />,
  )
  check("experiments-tab empty", <OpportunityExperimentsTab experiments={[]} {...common} />)
  check("workspace-scoring opportunity", <WorkspaceScoringPanel entityType={"OPPORTUNITY" as never} availableModels={[]} currentScoringModelId={null} {...common} />)
  check("workspace-scoring solution", <WorkspaceScoringPanel entityType={"SOLUTION" as never} availableModels={[]} currentScoringModelId={null} {...common} />)
  check("manage-squads empty", <ManageSquadsPanel initialSquads={[]} {...common} />)
  check("delete-workspace open", <DeleteWorkspacePanel workspaceName="Alpha" {...common} />, click(/delete workspace/i))
  check(
    "decision-sources",
    <DecisionSources
      entity={{ type: "OPPORTUNITY", id: "o1", title: "Need" } as never}
      sources={[{ type: "SOLUTION", id: "s1", title: "Fix", updatedAt: "2026-01-01T12:00:00Z" } as never]}
      {...common}
    />,
  )
  check(
    "new-decision-form",
    <NewDecisionForm workspaceId="w1" subjects={[{ type: "WORKSPACE", id: "w1", title: "Alpha" }, { type: "OPPORTUNITY", id: "o1", title: "Need" }]} {...common} />,
  )
  check("new-round-form empty", <NewRoundForm factors={[]} {...common} />)
  check("propose-new-entry open", <ProposeNewEntryButton roundId="r1" options={[]} {...common} />, click(/propose new entry/i))
  check(
    "feedback-action-cell",
    <FeedbackActionCell
      row={{ id: "f1", title: "Slow", description: null, submitterName: null, submitterEmail: null, status: "NEW", voteCount: 0, type: "IDEA", opportunityId: null, roadmapItem: null, createdAt: "2026-01-01T12:00:00Z", attachments: [] } as never}
      opportunities={[{ id: "o1", title: "Need" }]}
      workspaceId="w1"
      roadmapPath="/acme/alpha/roadmap"
      {...common}
    />,
  )
  check("unscheduled-solution", <UnscheduledItemPreview item={{ kind: "solution", id: "s1", title: "Fix", opportunityId: "o1", opportunityTitle: "Need", squadId: null }} />)
  check("measurements-panel", <MeasurementsPanel target={{ targetType: "KEY_RESULT", targetId: "k1" } as never} {...common} />)
  check(
    "canvas empty",
    <CanvasFlow overview={{ objectives: [], keyResults: [], opportunities: [], solutions: [], assumptions: [], experiments: [], roadmapItems: [], links: { opportunityObjective: [], solutionKeyResult: [] } } as never} />,
  )
  it("solution-panel", () => {
    entityDetail.data = {
      id: "s1", pmInterviews: [], title: "Fix", description: null, status: "IDEA", workspaceId: "w1",
      opportunity: { id: "o1", title: "Need", squadId: null }, assumptions: [], evidence: [], comments: [], roadmapItems: [],
      artifacts: [], availableArtifacts: [], deliveryTasks: [], linkableTasks: [], members: [], customFields: [], scoringModel: null, existingScore: null,
    }
    const { container } = render(<SolutionPanel id="s1" {...common} />)
    const actual = copyOf(container)
    recorded["solution-panel"] = actual
    if (!WRITE) expect(actual).toBe(expected["solution-panel"])
  })
  it("assumption-panel", () => {
    entityDetail.data = {
      id: "a1", pmInterviews: [], title: "Risky", description: null, riskLevel: "HIGH", status: "UNTESTED",
      solution: { id: "s1", title: "Fix", opportunity: { id: "o1", title: "Need" } }, experiments: [],
    }
    const { container } = render(<AssumptionPanel id="a1" {...common} />)
    const actual = copyOf(container)
    recorded["assumption-panel"] = actual
    if (!WRITE) expect(actual).toBe(expected["assumption-panel"])
  })
  it("feedback-panel", () => {
    entityDetail.data = {
      id: "f1", title: "Slow", description: null, type: "IDEA", status: "NEW", voteCount: 0, submitterName: null,
      opportunity: { id: "o1", title: "Need" }, attachments: [], _count: { votes: 0 }, deliveryTasks: [], linkableTasks: [], members: [],
    }
    const { container } = render(<FeedbackPanel id="f1" {...common} />)
    const actual = copyOf(container)
    recorded["feedback-panel"] = actual
    if (!WRITE) expect(actual).toBe(expected["feedback-panel"])
  })
})
