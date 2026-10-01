// @vitest-environment jsdom

/**
 * Component-level proof that converted surfaces follow the workspace's thinking
 * model, per preset, and that CLASSIC (and "no provider at all", the portal / help
 * / embed case) renders exactly today's copy.
 *
 * This renders real components. It is NOT a visual check: it asserts text, not
 * layout or styling.
 */

import { createElement, type ReactNode } from "react"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("next/navigation", () => ({
  usePathname: () => "/acme/alpha/okrs",
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}))
vi.mock("@/app/[orgSlug]/[workspaceSlug]/okrs/actions", () => ({
  createObjective: vi.fn(),
  createCycle: vi.fn(),
  addKeyResult: vi.fn(),
  deleteKeyResult: vi.fn(),
  setObjectiveParentKR: vi.fn(),
}))

import { ThinkingModelProvider } from "@/components/thinking-model/thinking-model-provider"
import { resolveThinkingModel } from "@/lib/thinking-model/resolve"
import { BottomNav } from "@/components/bottom-nav"
import { AddObjectiveForm } from "@/components/okrs/add-objective-form"
import { AddKeyResultForm } from "@/components/okrs/add-key-result-form"
import { CreateCycleForm } from "@/components/okrs/create-cycle-form"
import { CycleCard } from "@/components/okrs/cycle-card"
import { linkedTypeLabels, linkedTypePluralLabels } from "@/components/tasks/linked-type-labels"
import { objectTypeLabels } from "@/components/custom-fields/object-type-labels"

afterEach(cleanup)

const withModel = (source: Parameters<typeof resolveThinkingModel>[0], ui: ReactNode) =>
  <ThinkingModelProvider value={resolveThinkingModel(source)}>{ui}</ThinkingModelProvider>

const cycle = {
  id: "c1",
  title: "Q3",
  startDate: new Date("2026-07-01"),
  endDate: new Date("2026-09-30"),
  status: "ACTIVE" as const,
}

describe("CLASSIC copy is unchanged (no provider, NULL, and explicit CLASSIC all agree)", () => {
  const variants: Array<[string, (ui: ReactNode) => ReactNode]> = [
    ["no provider", (ui) => ui],
    ["NULL key", (ui) => withModel({ thinkingModel: null }, ui)],
    ["explicit CLASSIC", (ui) => withModel({ thinkingModel: "CLASSIC" }, ui)],
  ]

  it.each(variants)("%s", (_name, wrap) => {
    render(wrap(createElement(BottomNav, { orgSlug: "acme", workspaceSlug: "alpha" })))
    expect(screen.getByText("OKRs")).toBeInTheDocument()
    cleanup()

    render(wrap(createElement(AddObjectiveForm, { cycleId: "c1", orgSlug: "acme", workspaceSlug: "alpha" })))
    fireEvent.click(screen.getByRole("button", { name: "Add objective" }))
    expect(screen.getByText("Add Objective")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Add objective" })).toBeInTheDocument()
    cleanup()

    render(wrap(createElement(AddKeyResultForm, { objectiveId: "o1", objectiveTitle: "Grow", orgSlug: "acme", workspaceSlug: "alpha" })))
    expect(screen.getByRole("button", { name: "Add key result" })).toBeInTheDocument()
    cleanup()

    render(wrap(createElement(CreateCycleForm, { workspaceId: "w1", orgSlug: "acme", workspaceSlug: "alpha" })))
    expect(screen.getByRole("button", { name: "New Cycle" })).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "New Cycle" }))
    expect(screen.getByText("New OKR Cycle")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Create cycle" })).toBeInTheDocument()
    cleanup()

    render(wrap(createElement(CycleCard, { cycle: { ...cycle, _count: { objectives: 0 } }, orgSlug: "acme", workspaceSlug: "alpha" })))
    expect(screen.getByText("No objectives yet")).toBeInTheDocument()
    cleanup()
    render(wrap(createElement(CycleCard, { cycle: { ...cycle, _count: { objectives: 1 } }, orgSlug: "acme", workspaceSlug: "alpha" })))
    expect(screen.getByText("1 objective")).toBeInTheDocument()
    cleanup()
    render(wrap(createElement(CycleCard, { cycle: { ...cycle, _count: { objectives: 3 } }, orgSlug: "acme", workspaceSlug: "alpha" })))
    expect(screen.getByText("3 objectives")).toBeInTheDocument()
  })

  it("every CLASSIC label equals today's literal", () => {
    const l = resolveThinkingModel({ thinkingModel: null }).labels
    expect(l.opportunity).toMatchObject({ singular: "Opportunity", plural: "Opportunities", lower: "opportunity", lowerPlural: "opportunities" })
    expect(l.objective).toMatchObject({ singular: "Objective", plural: "Objectives", lower: "objective", lowerPlural: "objectives" })
    expect(l.keyResult).toMatchObject({
      singular: "Key Result",
      plural: "Key Results",
      lower: "key result",
      lowerPlural: "key results",
      short: "KR",
      shortPlural: "KRs",
      sentence: "Key result",
      sentencePlural: "Key results",
    })
    expect(l.solution).toMatchObject({ singular: "Solution", plural: "Solutions", lower: "solution", lowerPlural: "solutions" })
    expect(l.cycle).toMatchObject({ singular: "Cycle", plural: "Cycles", lower: "cycle", lowerPlural: "cycles" })
    expect(l.sections.okrs).toBe("OKRs")
  })

  it("table-driven copy templates match the literals they replaced", () => {
    const l = resolveThinkingModel({ thinkingModel: null }).labels
    const table: Array<[string, string]> = [
      [`Link to parent ${l.keyResult.singular}…`, "Link to parent Key Result…"],
      [`Delete ${l.objective.singular}`, "Delete Objective"],
      [`Linked ${l.keyResult.singular}`, "Linked Key Result"],
      [`Unlink parent ${l.keyResult.singular}`, "Unlink parent Key Result"],
      [
        `Search ${l.cycle.lowerPlural}, ${l.objective.lowerPlural}, and ${l.keyResult.shortPlural}…`,
        "Search cycles, objectives, and KRs…",
      ],
      [
        `No eligible parent ${l.keyResult.shortPlural}. A longer ${l.cycle.lower} must be Draft or Active and fully contain this ${l.cycle.lower}'s dates.`,
        "No eligible parent KRs. A longer cycle must be Draft or Active and fully contain this cycle's dates.",
      ],
      [`Link supporting ${l.objective.lower}…`, "Link supporting objective…"],
      [`Delete ${l.keyResult.short}`, "Delete KR"],
      [`Search shorter-${l.cycle.lower} ${l.objective.plural}…`, "Search shorter-cycle Objectives…"],
      [`No eligible unlinked ${l.objective.plural}.`, "No eligible unlinked Objectives."],
      [`Supporting ${l.objective.lowerPlural}`, "Supporting objectives"],
      [`Track ${l.objective.lowerPlural} and ${l.keyResult.lowerPlural} across ${l.cycle.lowerPlural}.`, "Track objectives and key results across cycles."],
      [`${l.cycle.plural} group your ${l.objective.lowerPlural} into time-boxed periods. Create one to start setting goals.`, "Cycles group your objectives into time-boxed periods. Create one to start setting goals."],
      [`Driving ${l.keyResult.singular}`, "Driving Key Result"],
      [`change ${l.keyResult.short}`, "change KR"],
      [`Link to ${l.keyResult.lower}`, "Link to key result"],
      [`No supporting ${l.objective.plural} linked.`, "No supporting Objectives linked."],
      [`Linked ${l.opportunity.plural}`, "Linked Opportunities"],
      [`No ${l.opportunity.lowerPlural} linked.`, "No opportunities linked."],
      [`Supporting ${l.objective.plural}`, "Supporting Objectives"],
    ]
    for (const [built, literal] of table) expect(built).toBe(literal)

    const types = linkedTypeLabels(resolveThinkingModel({}).labels)
    expect(types).toMatchObject({ OPPORTUNITY: "Opportunity", SOLUTION: "Solution", OBJECTIVE: "Objective", KEY_RESULT: "Key Result" })
    const plurals = linkedTypePluralLabels(resolveThinkingModel({}).labels)
    expect(plurals).toMatchObject({ OPPORTUNITY: "Opportunities", SOLUTION: "Solutions", OBJECTIVE: "Objectives", KEY_RESULT: "Key results" })
    expect(objectTypeLabels(resolveThinkingModel({}).labels)).toMatchObject({
      OPPORTUNITY: "Opportunity",
      SOLUTION: "Solution",
      OBJECTIVE: "Objective",
      KEY_RESULT: "Key Result",
    })
  })
})

describe("TORRES_OST renames a whole screen consistently", () => {
  const torres = { thinkingModel: "TORRES_OST" }

  it("nav, add forms and cycle card agree on Outcome / Success metric", () => {
    render(withModel(torres, createElement(BottomNav, { orgSlug: "acme", workspaceSlug: "alpha" })))
    expect(screen.getByText("Outcomes")).toBeInTheDocument()
    expect(screen.queryByText("OKRs")).not.toBeInTheDocument()
    cleanup()

    render(withModel(torres, createElement(AddObjectiveForm, { cycleId: "c1", orgSlug: "acme", workspaceSlug: "alpha" })))
    fireEvent.click(screen.getByRole("button", { name: "Add outcome" }))
    expect(screen.getByText("Add Outcome")).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/objective/i)
    cleanup()

    render(withModel(torres, createElement(AddKeyResultForm, { objectiveId: "o1", objectiveTitle: "Grow", orgSlug: "acme", workspaceSlug: "alpha" })))
    expect(screen.getByRole("button", { name: "Add success metric" })).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/key result/i)
    cleanup()

    render(withModel(torres, createElement(CycleCard, { cycle: { ...cycle, _count: { objectives: 2 } }, orgSlug: "acme", workspaceSlug: "alpha" })))
    expect(screen.getByText("2 outcomes")).toBeInTheDocument()
  })

  it("OPPORTUNITY_FIRST_OKR renders CLASSIC names", () => {
    render(withModel({ thinkingModel: "OPPORTUNITY_FIRST_OKR" }, createElement(BottomNav, { orgSlug: "acme", workspaceSlug: "alpha" })))
    expect(screen.getByText("OKRs")).toBeInTheDocument()
  })

  it("a label override reaches the UI", () => {
    render(
      withModel(
        { thinkingModel: "CLASSIC", thinkingModelLabels: JSON.stringify({ objective: { singular: "Goal", plural: "Goals" } }) },
        createElement(CycleCard, { cycle: { ...cycle, _count: { objectives: 1 } }, orgSlug: "acme", workspaceSlug: "alpha" }),
      ),
    )
    expect(screen.getByText("1 goal")).toBeInTheDocument()
  })
})
