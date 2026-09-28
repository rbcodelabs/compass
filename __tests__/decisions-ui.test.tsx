// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/app/[orgSlug]/[workspaceSlug]/reviews/actions", () => ({ decideReviewAction: vi.fn(), createTrackedDecisionAction: vi.fn() }))
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }))

import { createTrackedDecisionAction, decideReviewAction } from "@/app/[orgSlug]/[workspaceSlug]/reviews/actions"
import { DecisionActions } from "@/components/decisions/decision-actions"
import { NewDecisionForm } from "@/components/decisions/new-decision-form"
import { RequestDecisionLink } from "@/components/decisions/request-decision-link"

const decide = vi.mocked(decideReviewAction)
const create = vi.mocked(createTrackedDecisionAction)

describe("simple decision UI", () => {
  afterEach(cleanup)
  beforeEach(() => { vi.clearAllMocks() })

  it("shows a rationale field alongside all three outcomes", () => {
    render(<DecisionActions workspaceId="ws-1" revisionId="rev-1" fingerprint="fp" options={[
      { id: "a", label: "Approve", outcomeClass: "APPROVE" },
      { id: "c", label: "Request changes", outcomeClass: "REQUEST_CHANGES" },
      { id: "r", label: "Reject", outcomeClass: "REJECT" },
    ]} />)
    expect(screen.getByLabelText(/rationale/i)).toBeDefined()
    expect(screen.getByRole("button", { name: "Approve" })).toBeDefined()
    expect(screen.getByRole("button", { name: "Request changes" })).toBeDefined()
    expect(screen.getByRole("button", { name: "Reject" })).toBeDefined()
  })

  it("renders the standard outcomes as plain buttons, with no choice cards, when no options were supplied", () => {
    render(<DecisionActions workspaceId="ws-1" revisionId="rev-1" fingerprint="fp" options={[
      { id: "a", label: "Approve", outcomeClass: "APPROVE", actionKey: "APPROVE", description: null },
      { id: "c", label: "Request changes", outcomeClass: "REQUEST_CHANGES", actionKey: "REQUEST_CHANGES" },
      { id: "r", label: "Reject", outcomeClass: "REJECT", actionKey: "REJECT" },
    ]} />)
    expect(screen.queryAllByRole("radio")).toHaveLength(0)
    expect(screen.queryByRole("button", { name: "Confirm choice" })).toBeNull()
    expect(screen.getByText(/required for changes or rejection/i).textContent).toBe("(required for changes or rejection)")
  })

  it("approves immediately through the standard Approve button", async () => {
    render(<DecisionActions workspaceId="ws-1" revisionId="rev-1" fingerprint="fp" options={[{ id: "a", label: "Approve", outcomeClass: "APPROVE" }]} />)
    fireEvent.click(screen.getByRole("button", { name: "Approve" }))
    await waitFor(() => expect(decide).toHaveBeenCalledWith({ workspaceId: "ws-1", revisionId: "rev-1", fingerprint: "fp", optionId: "a", rationale: "" }))
  })

  it("builds a prefilled entity request link", () => {
    render(<RequestDecisionLink orgSlug="acme" workspaceSlug="product" subjectType="SOLUTION" subjectId="solution-1" subjectTitle="Simple decisions" />)
    expect(screen.getByRole("link", { name: /request decision/i }).getAttribute("href")).toContain("subjectType=SOLUTION")
  })
})

describe("decision UI with custom options", () => {
  afterEach(cleanup)
  beforeEach(() => { vi.clearAllMocks() })

  const options = [
    { id: "c1", label: "Ship now", description: "Release this week.", outcomeClass: "APPROVE", actionKey: "CHOICE_1" },
    { id: "c2", label: "Wait a sprint", description: null, outcomeClass: "APPROVE", actionKey: "CHOICE_2" },
    { id: "chg", label: "Request changes", outcomeClass: "REQUEST_CHANGES", actionKey: "REQUEST_CHANGES", description: null },
    { id: "rej", label: "Reject", outcomeClass: "REJECT", actionKey: "REJECT", description: null },
  ]
  const renderActions = () => render(<DecisionActions workspaceId="ws-1" revisionId="rev-1" fingerprint="fp" options={options} />)

  it("renders each custom option as a selectable card with its label and description, and Request changes / Reject as secondary buttons", () => {
    renderActions()
    const radios = screen.getAllByRole("radio")
    expect(radios).toHaveLength(2)
    const ship = screen.getByRole("radio", { name: /Ship now/ })
    expect(within(ship.closest("label") as HTMLElement).getByText("Release this week.")).toBeDefined()
    expect(screen.getByRole("radio", { name: /Wait a sprint/ })).toBeDefined()
    expect(screen.getByRole("button", { name: "Request changes" })).toBeDefined()
    expect(screen.getByRole("button", { name: "Reject" })).toBeDefined()
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull()
  })

  it("requires a selection before confirming, then records that option without a rationale", async () => {
    renderActions()
    const confirm = screen.getByRole("button", { name: "Confirm choice" }) as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    fireEvent.click(screen.getByRole("radio", { name: /Ship now/ }))
    expect(confirm.disabled).toBe(false)
    fireEvent.click(confirm)
    await waitFor(() => expect(decide).toHaveBeenCalledWith({ workspaceId: "ws-1", revisionId: "rev-1", fingerprint: "fp", optionId: "c1", rationale: "" }))
    expect(screen.queryByRole("alert")).toBeNull()
  })

  it("sends the optional rationale along with the chosen option", async () => {
    renderActions()
    fireEvent.click(screen.getByRole("radio", { name: /Wait a sprint/ }))
    fireEvent.change(screen.getByLabelText(/rationale/i), { target: { value: "Capacity is tight." } })
    fireEvent.click(screen.getByRole("button", { name: "Confirm choice" }))
    await waitFor(() => expect(decide).toHaveBeenCalledWith(expect.objectContaining({ optionId: "c2", rationale: "Capacity is tight." })))
  })

  it.each(["Request changes", "Reject"])("still requires a rationale for %s", async (label) => {
    renderActions()
    fireEvent.click(screen.getByRole("button", { name: label }))
    expect((await screen.findByRole("alert")).textContent).toMatch(/rationale/i)
    expect(decide).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText(/rationale/i), { target: { value: "Not viable." } })
    fireEvent.click(screen.getByRole("button", { name: label }))
    await waitFor(() => expect(decide).toHaveBeenCalledWith(expect.objectContaining({ optionId: label === "Reject" ? "rej" : "chg", rationale: "Not viable." })))
  })

  it("wraps long labels instead of clipping them", () => {
    const long = "A".repeat(120)
    render(<DecisionActions workspaceId="ws-1" revisionId="rev-1" fingerprint="fp" options={[{ ...options[0], label: long }, options[1], options[2], options[3]]} />)
    const label = screen.getByText(long)
    expect(label.className).toContain("break-words")
    expect(label.className).not.toContain("truncate")
  })
})

describe("new decision form options editor", () => {
  afterEach(cleanup)
  beforeEach(() => {
    vi.clearAllMocks()
    create.mockResolvedValue({ requestId: "request-1", revisionId: "rev-1" })
  })

  const subjects = [{ type: "WORKSPACE" as const, id: "ws-1", title: "Workspace" }]
  const renderForm = (props: Partial<Parameters<typeof NewDecisionForm>[0]> = {}) => render(<NewDecisionForm workspaceId="ws-1" orgSlug="acme" workspaceSlug="product" subjects={subjects} {...props} />)
  const fillCore = () => {
    fireEvent.change(screen.getByPlaceholderText("What needs to be decided?"), { target: { value: "Which plan?" } })
    fireEvent.change(screen.getByPlaceholderText(/Give the reviewer enough context/), { target: { value: "Pick one." } })
  }
  const submit = () => fireEvent.click(screen.getByRole("button", { name: "Request decision" }))

  it("starts with no options and submits an empty list so the standard three apply", async () => {
    renderForm()
    expect(screen.queryByLabelText(/Option 1 label/)).toBeNull()
    fillCore()
    submit()
    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({ options: [] })))
  })

  it("adds a first pair of options, then singles up to four, and can remove them", () => {
    renderForm()
    fireEvent.click(screen.getByRole("button", { name: "Add answer options" }))
    expect(screen.getAllByLabelText(/Option \d label/)).toHaveLength(2)
    fireEvent.click(screen.getByRole("button", { name: "Add option" }))
    fireEvent.click(screen.getByRole("button", { name: "Add option" }))
    expect(screen.getAllByLabelText(/Option \d label/)).toHaveLength(4)
    expect((screen.getByRole("button", { name: "Add option" }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole("button", { name: "Remove option 4" }))
    expect(screen.getAllByLabelText(/Option \d label/)).toHaveLength(3)
  })

  it("submits trimmed options with optional descriptions through the action", async () => {
    renderForm()
    fillCore()
    fireEvent.click(screen.getByRole("button", { name: "Add answer options" }))
    fireEvent.change(screen.getByLabelText("Option 1 label"), { target: { value: " Ship now " } })
    fireEvent.change(screen.getByLabelText("Option 1 description"), { target: { value: " Soon " } })
    fireEvent.change(screen.getByLabelText("Option 2 label"), { target: { value: "Wait" } })
    submit()
    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({ question: "Which plan?", options: [{ label: "Ship now", description: "Soon" }, { label: "Wait" }] })))
  })

  it("ignores an untouched blank pair instead of blocking a plain decision", async () => {
    renderForm()
    fillCore()
    fireEvent.click(screen.getByRole("button", { name: "Add answer options" }))
    submit()
    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({ options: [] })))
  })

  it("blocks a single option and a description with no label", () => {
    renderForm()
    fillCore()
    fireEvent.click(screen.getByRole("button", { name: "Add answer options" }))
    fireEvent.change(screen.getByLabelText("Option 1 label"), { target: { value: "Only" } })
    submit()
    expect(screen.getByRole("alert").textContent).toMatch(/at least 2 options/)
    fireEvent.change(screen.getByLabelText("Option 2 description"), { target: { value: "No label" } })
    submit()
    expect(screen.getByRole("alert").textContent).toMatch(/label/)
    expect(create).not.toHaveBeenCalled()
  })

  it("prefills the prior options in revise mode and lets them be cleared back to the defaults", async () => {
    renderForm({
      initial: { type: "WORKSPACE", id: "ws-1", question: "Which plan?", context: "Pick one.", options: [{ label: "Ship now", description: "Soon" }, { label: "Wait" }] },
      revise: { requestId: "request-1", expectedDecisionId: "decision-1", reason: "Changes needed." },
    })
    expect((screen.getByLabelText("Option 1 label") as HTMLInputElement).value).toBe("Ship now")
    expect((screen.getByLabelText("Option 1 description") as HTMLTextAreaElement).value).toBe("Soon")
    expect((screen.getByLabelText("Option 2 label") as HTMLInputElement).value).toBe("Wait")
    fireEvent.click(screen.getByRole("button", { name: "Remove option 2" }))
    fireEvent.click(screen.getByRole("button", { name: "Remove option 1" }))
    submit()
    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({ options: [], revise: expect.objectContaining({ requestId: "request-1" }) })))
  })

  it("submits inherited options unchanged when revising without edits", async () => {
    renderForm({
      initial: { type: "WORKSPACE", id: "ws-1", question: "Q", context: "C", options: [{ label: "Ship now", description: "Soon" }, { label: "Wait" }] },
      revise: { requestId: "request-1", expectedDecisionId: "decision-1", reason: "Changes needed." },
    })
    submit()
    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({ options: [{ label: "Ship now", description: "Soon" }, { label: "Wait" }] })))
  })
})
