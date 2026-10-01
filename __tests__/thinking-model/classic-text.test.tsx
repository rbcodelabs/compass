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
