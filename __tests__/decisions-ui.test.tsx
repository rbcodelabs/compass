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

  it("explains duplicate and reserved labels on the client instead of relying on a masked server error", () => {
    renderForm()
    fillCore()
    fireEvent.click(screen.getByRole("button", { name: "Add answer options" }))
    fireEvent.change(screen.getByLabelText("Option 1 label"), { target: { value: "Postgres" } })
    fireEvent.change(screen.getByLabelText("Option 2 label"), { target: { value: " postgres " } })
    submit()
    expect(screen.getByRole("alert").textContent).toMatch(/must be unique/)
    fireEvent.change(screen.getByLabelText("Option 2 label"), { target: { value: "Reject" } })
    submit()
    expect(screen.getByRole("alert").textContent).toMatch(/reserved/)
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

describe("decision UI with multiple questions", () => {
  afterEach(cleanup)
  beforeEach(() => { vi.clearAllMocks() })

  const options = [
    { id: "sub", label: "Submit answers", description: null, outcomeClass: "APPROVE", actionKey: "SUBMIT_ANSWERS" },
    { id: "chg", label: "Request changes", outcomeClass: "REQUEST_CHANGES", actionKey: "REQUEST_CHANGES", description: null },
    { id: "rej", label: "Reject", outcomeClass: "REJECT", actionKey: "REJECT", description: null },
  ]
  const questions = [
    { header: "Timing", question: "When do we ship?", options: [{ label: "Now", description: "This week." }, { label: "Later" }] },
    { question: "Who announces it?", options: [{ label: "PM" }, { label: "Marketing" }] },
  ]
  const renderActions = () => render(<DecisionActions workspaceId="ws-1" revisionId="rev-1" fingerprint="fp" options={options} questions={questions} />)

  it("renders each question as its own radio group with its header, question, options and descriptions", () => {
    renderActions()
    const groups = screen.getAllByRole("group")
    expect(groups).toHaveLength(2)
    expect(within(groups[0]).getByText("Timing")).toBeDefined()
    expect(within(groups[0]).getByText("When do we ship?")).toBeDefined()
    expect(within(groups[0]).getAllByRole("radio")).toHaveLength(2)
    expect(within(groups[0]).getByText("This week.")).toBeDefined()
    expect(within(groups[1]).getByText("Who announces it?")).toBeDefined()
    expect(within(groups[1]).getAllByRole("radio")).toHaveLength(2)
    expect(screen.getByRole("button", { name: "Request changes" })).toBeDefined()
    expect(screen.getByRole("button", { name: "Reject" })).toBeDefined()
    expect(screen.queryByRole("button", { name: "Confirm choice" })).toBeNull()
  })

  it("keeps Submit answers disabled until every question is answered, then submits one answer per question", async () => {
    renderActions()
    const submit = screen.getByRole("button", { name: "Submit answers" }) as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    expect(screen.getByText("2 questions left to answer.")).toBeDefined()
    fireEvent.click(within(screen.getAllByRole("group")[0]).getByRole("radio", { name: /Now/ }))
    expect(submit.disabled).toBe(true)
    expect(screen.getByText("1 question left to answer.")).toBeDefined()
    fireEvent.click(within(screen.getAllByRole("group")[1]).getByRole("radio", { name: /Marketing/ }))
    expect(submit.disabled).toBe(false)
    fireEvent.click(submit)
    await waitFor(() => expect(decide).toHaveBeenCalledWith({ workspaceId: "ws-1", revisionId: "rev-1", fingerprint: "fp", optionId: "sub", rationale: "", answers: [{ questionIndex: 0, chosenOption: "Now" }, { questionIndex: 1, chosenOption: "Marketing" }] }))
  })

  it("lets an answer be changed before submitting", async () => {
    renderActions()
    const groups = screen.getAllByRole("group")
    fireEvent.click(within(groups[0]).getByRole("radio", { name: /Now/ }))
    fireEvent.click(within(groups[0]).getByRole("radio", { name: /Later/ }))
    fireEvent.click(within(groups[1]).getByRole("radio", { name: /PM/ }))
    fireEvent.click(screen.getByRole("button", { name: "Submit answers" }))
    await waitFor(() => expect(decide).toHaveBeenCalledWith(expect.objectContaining({ answers: [{ questionIndex: 0, chosenOption: "Later" }, { questionIndex: 1, chosenOption: "PM" }] })))
  })

  it.each(["Request changes", "Reject"])("applies %s to the whole request: needs a rationale, not answers", async (label) => {
    renderActions()
    fireEvent.click(screen.getByRole("button", { name: label }))
    expect((await screen.findByRole("alert")).textContent).toMatch(/rationale/i)
    expect(decide).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText(/rationale/i), { target: { value: "Not viable." } })
    fireEvent.click(screen.getByRole("button", { name: label }))
    await waitFor(() => expect(decide).toHaveBeenCalledWith({ workspaceId: "ws-1", revisionId: "rev-1", fingerprint: "fp", optionId: label === "Reject" ? "rej" : "chg", rationale: "Not viable." }))
  })

  it("wraps long questions and labels instead of clipping them", () => {
    const long = "Q".repeat(200)
    const longLabel = "L".repeat(120)
    render(<DecisionActions workspaceId="ws-1" revisionId="rev-1" fingerprint="fp" options={options} questions={[{ question: long, options: [{ label: longLabel }, { label: "B" }] }]} />)
    expect(screen.getByText(long).className).toContain("break-words")
    expect(screen.getByText(longLabel).className).toContain("break-words")
  })

  it("renders the legacy single-options cards unchanged when no questions are passed", () => {
    render(<DecisionActions workspaceId="ws-1" revisionId="rev-1" fingerprint="fp" options={[
      { id: "c1", label: "Ship now", description: null, outcomeClass: "APPROVE", actionKey: "CHOICE_1" },
      { id: "c2", label: "Wait", description: null, outcomeClass: "APPROVE", actionKey: "CHOICE_2" },
      { id: "chg", label: "Request changes", outcomeClass: "REQUEST_CHANGES", actionKey: "REQUEST_CHANGES" },
    ]} />)
    expect(screen.getByRole("button", { name: "Confirm choice" })).toBeDefined()
    expect(screen.queryByRole("button", { name: "Submit answers" })).toBeNull()
  })
})

describe("new decision form questions editor", () => {
  afterEach(cleanup)
  beforeEach(() => {
    vi.clearAllMocks()
    create.mockResolvedValue({ requestId: "request-1", revisionId: "rev-1" })
  })

  const subjects = [{ type: "WORKSPACE" as const, id: "ws-1", title: "Workspace" }]
  const renderForm = (props: Partial<Parameters<typeof NewDecisionForm>[0]> = {}) => render(<NewDecisionForm workspaceId="ws-1" orgSlug="acme" workspaceSlug="product" subjects={subjects} {...props} />)
  const fillCore = () => {
    fireEvent.change(screen.getByPlaceholderText("What needs to be decided?"), { target: { value: "Plan the launch" } })
    fireEvent.change(screen.getByPlaceholderText(/Give the reviewer enough context/), { target: { value: "Answer each." } })
  }
  const submit = () => fireEvent.click(screen.getByRole("button", { name: "Request decision" }))
  const fillQuestion = (n: number, text: string, a: string, b: string) => {
    fireEvent.change(screen.getByLabelText(`Question ${n} text`), { target: { value: text } })
    fireEvent.change(screen.getByLabelText(`Question ${n} option 1 label`), { target: { value: a } })
    fireEvent.change(screen.getByLabelText(`Question ${n} option 2 label`), { target: { value: b } })
  }

  it("submits an empty questions list on the legacy path so nothing changes", async () => {
    renderForm()
    fillCore()
    submit()
    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({ options: [], questions: [] })))
  })

  it("adds questions (each starting with two options) up to four and removes them", () => {
    renderForm()
    fireEvent.click(screen.getByRole("button", { name: "Add questions" }))
    expect(screen.getAllByLabelText(/Question \d text/)).toHaveLength(1)
    expect(screen.getAllByLabelText(/Question 1 option \d label/)).toHaveLength(2)
    for (let i = 0; i < 3; i++) fireEvent.click(screen.getByRole("button", { name: "Add question" }))
    expect(screen.getAllByLabelText(/Question \d text/)).toHaveLength(4)
    expect((screen.getByRole("button", { name: "Add question" }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole("button", { name: "Remove question 4" }))
    expect(screen.getAllByLabelText(/Question \d text/)).toHaveLength(3)
    fireEvent.click(screen.getByRole("button", { name: "Add option to question 1" }))
    fireEvent.click(screen.getByRole("button", { name: "Add option to question 1" }))
    expect((screen.getByRole("button", { name: "Add option to question 1" }) as HTMLButtonElement).disabled).toBe(true)
  })

  it("submits trimmed questions with headers and descriptions", async () => {
    renderForm()
    fillCore()
    fireEvent.click(screen.getByRole("button", { name: "Add questions" }))
    fireEvent.click(screen.getByRole("button", { name: "Add question" }))
    fireEvent.change(screen.getByLabelText("Question 1 header"), { target: { value: " Timing " } })
    fillQuestion(1, " When? ", " Now ", "Later")
    fireEvent.change(screen.getByLabelText("Question 1 option 1 description"), { target: { value: " This week " } })
    fillQuestion(2, "Who?", "PM", "Marketing")
    submit()
    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({
      question: "Plan the launch",
      options: [],
      questions: [
        { header: "Timing", question: "When?", options: [{ label: "Now", description: "This week" }, { label: "Later" }] },
        { question: "Who?", options: [{ label: "PM" }, { label: "Marketing" }] },
      ],
    })))
  })

  it("makes questions and the single options editor mutually exclusive", () => {
    renderForm()
    fireEvent.click(screen.getByRole("button", { name: "Add answer options" }))
    expect((screen.getByRole("button", { name: "Add questions" }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole("button", { name: "Remove option 1" }))
    fireEvent.click(screen.getByRole("button", { name: "Remove option 1" }))
    expect((screen.getByRole("button", { name: "Add questions" }) as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(screen.getByRole("button", { name: "Add questions" }))
    expect((screen.getByRole("button", { name: "Add answer options" }) as HTMLButtonElement).disabled).toBe(true)
  })

  it("ignores an untouched blank question instead of blocking a plain decision", async () => {
    renderForm()
    fillCore()
    fireEvent.click(screen.getByRole("button", { name: "Add questions" }))
    submit()
    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({ questions: [] })))
  })

  it("explains a missing question text, too few options, duplicate labels and reserved labels without calling the action", async () => {
    renderForm()
    fillCore()
    fireEvent.click(screen.getByRole("button", { name: "Add questions" }))
    fireEvent.change(screen.getByLabelText("Question 1 option 1 label"), { target: { value: "A" } })
    submit()
    expect(screen.getByRole("alert").textContent).toBe("Question 1 needs its question text.")

    fireEvent.change(screen.getByLabelText("Question 1 text"), { target: { value: "Which?" } })
    submit()
    expect(screen.getByRole("alert").textContent).toMatch(/Question 1 needs at least 2 options/)

    fireEvent.change(screen.getByLabelText("Question 1 option 2 label"), { target: { value: " a " } })
    submit()
    expect(screen.getByRole("alert").textContent).toMatch(/Question 1: Option labels must be unique/)

    fireEvent.change(screen.getByLabelText("Question 1 option 2 label"), { target: { value: "Reject" } })
    submit()
    expect(screen.getByRole("alert").textContent).toMatch(/Question 1: "Reject" is reserved/)
    expect(create).not.toHaveBeenCalled()
  })

  it("prefills prior questions in revise mode and lets them be cleared back to the defaults", async () => {
    renderForm({
      initial: { type: "WORKSPACE", id: "ws-1", question: "Plan", context: "C", questions: [{ header: "Timing", question: "When?", options: [{ label: "Now" }, { label: "Later" }] }] },
      revise: { requestId: "request-1", expectedDecisionId: "decision-1", reason: "Changes." },
    })
    expect((screen.getByLabelText("Question 1 text") as HTMLInputElement).value).toBe("When?")
    fireEvent.click(screen.getByRole("button", { name: "Remove question 1" }))
    submit()
    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({ options: [], questions: [], revise: expect.objectContaining({ requestId: "request-1" }) })))
  })
})
