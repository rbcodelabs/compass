// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"

const m = vi.hoisted(() => ({ saveSpecField: vi.fn(), createSpecSolution: vi.fn(), createSpecAssumption: vi.fn(), createSpecExperiment: vi.fn() }))
vi.mock("@/lib/spec-canvas/mutations", async (load) => ({
  ...(await load<typeof import("@/lib/spec-canvas/mutations")>()),
  saveSpecField: m.saveSpecField,
  createSpecSolution: m.createSpecSolution,
  createSpecAssumption: m.createSpecAssumption,
  createSpecExperiment: m.createSpecExperiment,
}))
// Server-action modules and the rich editors are not under test here.
vi.mock("@/app/[orgSlug]/[workspaceSlug]/discovery/actions", () => ({}))
vi.mock("@/app/[orgSlug]/[workspaceSlug]/experiments/actions", () => ({}))
vi.mock("@/components/panels/panel-parts", () => ({ patchEntityField: vi.fn() }))
vi.mock("@/components/markdown-description-editor", () => ({ MarkdownDescriptionEditor: ({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) => <textarea aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} /> }))
vi.mock("@/components/markdown-content", () => ({ MarkdownContent: ({ children }: { children: string }) => <p>{children}</p> }))
vi.mock("@/components/docs/artifact-preview", () => ({ ArtifactPreview: () => null }))

import { SpecDocument } from "@/components/discovery/spec-canvas/spec-document"
import { buildSpecAssumption, buildSpecExperiment, buildSpecSolution, type SpecCanvas } from "@/lib/spec-canvas/shape"
import { resolveThinkingModel } from "@/lib/thinking-model/resolve"

const slugs = { orgSlug: "acme", workspaceSlug: "growth" }
const context = { ...slugs, workspaceId: "ws-1", opportunityId: "opp-1" }
const labels = resolveThinkingModel({}).labels

function spec(): SpecCanvas {
  return {
    opportunity: { id: "opp-1", displayId: "OPP-4", title: "Scattered work", description: "Old description", status: "EXPLORING", statusTone: "info", customerSegment: null, href: "/o" },
    evidence: [],
    objectives: [],
    solutions: [buildSpecSolution({ id: "s1", title: "Spec canvas", description: null, status: "IDEA" }, slugs, "opp-1")],
    assumptions: [buildSpecAssumption({ id: "a1", title: "People read it", description: null, riskLevel: "HIGH", status: "UNTESTED" }, { id: "s1", title: "Spec canvas" }, slugs, "opp-1")],
    experiments: [],
    artifacts: [],
  }
}
const renderDoc = (readOnly = false) => render(<SpecDocument spec={spec()} labels={labels} backHref="/back" context={context} readOnly={readOnly} />)

beforeEach(() => {
  vi.resetAllMocks()
  m.saveSpecField.mockResolvedValue(undefined)
  vi.stubGlobal("IntersectionObserver", class { observe() {} disconnect() {} unobserve() {} })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe("SpecDocument editing", () => {
  it("click-to-edit saves a title on Enter, optimistically", async () => {
    renderDoc()
    fireEvent.click(screen.getByRole("button", { name: "Edit solution title" }))
    const input = screen.getByRole("textbox", { name: "solution title" })
    fireEvent.change(input, { target: { value: "Spec canvas v2" } })
    fireEvent.keyDown(input, { key: "Enter" })
    expect(await screen.findByRole("button", { name: "Edit solution title" })).toHaveTextContent("Spec canvas v2")
    expect(m.saveSpecField).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-1" }), "solution", "s1", "title", "Spec canvas v2")
    await waitFor(() => expect(screen.getByTestId("spec-save-state")).toHaveTextContent("Saved"))
  })

  it("reverts and reports a failed save", async () => {
    m.saveSpecField.mockRejectedValue(new Error("boom"))
    renderDoc()
    fireEvent.click(screen.getByRole("button", { name: "Edit solution title" }))
    const input = screen.getByRole("textbox", { name: "solution title" })
    fireEvent.change(input, { target: { value: "Nope" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() => expect(screen.getByTestId("spec-save-state")).toHaveTextContent("Could not save"))
    expect(screen.getByRole("button", { name: "Edit solution title" })).toHaveTextContent("Spec canvas")
  })

  it("does not send an emptied title", async () => {
    renderDoc()
    fireEvent.click(screen.getByRole("button", { name: "Edit solution title" }))
    const input = screen.getByRole("textbox", { name: "solution title" })
    fireEvent.change(input, { target: { value: "  " } })
    fireEvent.blur(input)
    expect(m.saveSpecField).not.toHaveBeenCalled()
    expect(screen.getByRole("button", { name: "Edit solution title" })).toHaveTextContent("Spec canvas")
  })

  it("changes a risk level from the badge menu", async () => {
    renderDoc()
    fireEvent.click(screen.getByRole("button", { name: /Risk level: High\. Change/ }))
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Low" }))
    await waitFor(() => expect(m.saveSpecField).toHaveBeenCalledWith(expect.anything(), "assumption", "a1", "riskLevel", "LOW"))
    expect(await screen.findByRole("button", { name: /Risk level: Low\. Change/ })).toBeInTheDocument()
  })

  it("autosaves the opportunity description after leaving the editor", async () => {
    renderDoc()
    fireEvent.click(screen.getByRole("button", { name: "Edit opportunity description" }))
    fireEvent.change(screen.getByRole("textbox", { name: "opportunity description" }), { target: { value: "Fresh words" } })
    fireEvent.blur(screen.getByRole("textbox", { name: "opportunity description" }))
    await waitFor(() => expect(m.saveSpecField).toHaveBeenCalledWith(expect.anything(), "opportunity", "opp-1", "description", "Fresh words"))
  })
})

describe("SpecDocument creation", () => {
  it("adds a solution on Enter, keeps the input open, and updates the rail count", async () => {
    m.createSpecSolution.mockResolvedValue(buildSpecSolution({ id: "s2", title: "Second", description: null, status: "IDEA" }, slugs, "opp-1"))
    renderDoc()
    const rail = screen.getByRole("navigation", { name: "Spec traceability" })
    expect(within(rail).getByText("Solutions").nextSibling).toHaveTextContent("1")
    fireEvent.click(screen.getByRole("button", { name: "Add solution" }))
    const input = screen.getByRole("textbox", { name: "Add solution" })
    fireEvent.change(input, { target: { value: "Second" } })
    fireEvent.keyDown(input, { key: "Enter" })
    expect(await screen.findByRole("button", { name: "Edit solution title", hidden: false, description: undefined } as never)).toBeTruthy()
    await waitFor(() => expect(within(rail).getByText("Solutions").nextSibling).toHaveTextContent("2"))
    expect(m.createSpecSolution).toHaveBeenCalledWith(expect.anything(), "Second")
    expect(screen.getByRole("textbox", { name: "Add solution" })).toHaveValue("")
  })

  it("adds an experiment under the chosen assumption", async () => {
    m.createSpecExperiment.mockResolvedValue(buildSpecExperiment({ id: "e1", title: "Try it", hypothesis: "Try it", status: "DESIGNING", conclusion: null, conclusionReason: null }, { id: "a1", title: "People read it" }, slugs))
    renderDoc()
    fireEvent.click(screen.getByRole("button", { name: "Add experiment" }))
    const input = screen.getByRole("textbox", { name: "Add experiment" })
    fireEvent.change(input, { target: { value: "Try it" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() => expect(m.createSpecExperiment).toHaveBeenCalledWith(expect.anything(), { id: "a1", title: "People read it" }, "Try it"))
    expect(await screen.findByRole("button", { name: "Edit experiment title" })).toHaveTextContent("Try it")
  })

  it("shows a creation error and keeps the typed title", async () => {
    m.createSpecSolution.mockRejectedValue(new Error("down"))
    renderDoc()
    fireEvent.click(screen.getByRole("button", { name: "Add solution" }))
    const input = screen.getByRole("textbox", { name: "Add solution" })
    fireEvent.change(input, { target: { value: "Keep me" } })
    fireEvent.keyDown(input, { key: "Enter" })
    expect(await screen.findAllByRole("alert")).not.toHaveLength(0)
    expect(input).toHaveValue("Keep me")
  })
})

describe("SpecDocument read-only workspace", () => {
  it("offers no editing or creation affordances", () => {
    renderDoc(true)
    expect(screen.queryByRole("button", { name: /^Edit / })).toBeNull()
    expect(screen.queryByRole("button", { name: /^Add / })).toBeNull()
    expect(screen.queryByRole("button", { name: "Insert" })).toBeNull()
  })
})
