// @vitest-environment jsdom
import * as React from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { DocCommentComposer } from "@/components/docs/doc-comment-composer"
import type { MentionOptions } from "@/components/docs/mention-editor"
import { parseMentions } from "@/lib/comment-mentions"

const QUINN = "6f1c2a40-1111-4222-8333-944455556666"
const QUENTIN = "7a1c2a40-1111-4222-8333-944455556667"
const BOT = "8b1c2a40-1111-4222-8333-944455556668"
const DANA = "9c1c2a40-1111-4222-8333-944455556669"

const options: MentionOptions = {
  people: [
    { kind: "user", id: QUINN, name: "Quinn Morales", detail: "quinn@example.com" },
    { kind: "user", id: QUENTIN, name: "Quentin Okafor", detail: "quentin@example.com" },
  ],
  agents: [{ kind: "agent", id: BOT, name: "QA Agent", detail: "Test plans", access: "WRITE" }],
  outside: [{ kind: "user", id: DANA, name: "Dana Whitfield", detail: "dana@example.com", outsideWorkspace: true }],
}

const onSubmit = vi.fn()
const editor = () => screen.getByRole("textbox", { name: "Comment" })

/** Put plain text in the editor with the caret at the end, the way typing leaves it. */
function type(text: string) {
  const el = editor()
  el.textContent = text
  const node = el.firstChild as Text
  const range = document.createRange()
  range.setStart(node, text.length)
  range.collapse(true)
  const selection = window.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
  fireEvent.input(el)
}

function pick(name: string) {
  const option = screen.getAllByTestId("mention-option").find(o => o.getAttribute("data-mention-name") === name)!
  fireEvent.click(option)
}

function renderComposer(extra: Partial<React.ComponentProps<typeof DocCommentComposer>> = {}) {
  return render(
    <DocCommentComposer
      options={options}
      confirmedAgentIds={[]}
      docTitle="Launch plan"
      anchorText="The rollout checklist still needs an owner"
      idleLabel="Comment"
      onSubmit={onSubmit}
      {...extra}
    />,
  )
}

beforeEach(() => {
  onSubmit.mockReset()
  onSubmit.mockResolvedValue({ ok: true })
  Object.defineProperty(document, "execCommand", { configurable: true, value: vi.fn(() => true) })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe("@ picker", () => {
  it("opens grouped, filtered suggestions and inserts a chip on Enter", () => {
    renderComposer()
    type("Can you draft this? @qu")
    expect(screen.getByRole("listbox", { name: "Mention suggestions" })).toBeInTheDocument()
    expect(screen.getByText("People")).toBeInTheDocument()
    // Both Qu* people match; the agent does not.
    expect(screen.getAllByTestId("mention-option").map(o => o.getAttribute("data-mention-name"))).toEqual(["Quentin Okafor", "Quinn Morales"])
    fireEvent.keyDown(editor(), { key: "ArrowDown" })
    fireEvent.keyDown(editor(), { key: "Enter" })
    const chip = screen.getByTestId("mention-chip")
    expect(chip).toHaveAttribute("data-mention-id", QUINN)
    expect(chip).toHaveTextContent("@Quinn Morales")
    expect(screen.queryByRole("listbox")).toBeNull()
  })

  it("lists agents with an Agent badge", () => {
    renderComposer()
    type("@qa")
    const option = screen.getByTestId("mention-option")
    expect(option).toHaveTextContent("QA Agent")
    expect(option).toHaveTextContent("Agent")
  })

  it("keeps matching across spaces so multi-word names can be typed out", () => {
    renderComposer()
    type("Pull baselines @QA Ag")
    expect(screen.getByTestId("mention-option")).toHaveTextContent("QA Agent")
    type("see you @ home")
    expect(screen.queryByRole("listbox")).toBeNull()
  })

  it("Escape dismisses the picker and leaves the literal @", () => {
    renderComposer()
    type("hi @qu")
    fireEvent.keyDown(editor(), { key: "Escape" })
    expect(screen.queryByRole("listbox")).toBeNull()
    expect(editor()).toHaveTextContent("hi @qu")
  })

  it("does not open for an @ in the middle of a word such as an email", () => {
    renderComposer()
    type("mail me at quinn@qu")
    expect(screen.queryByRole("listbox")).toBeNull()
  })
})

describe("create-task row", () => {
  it("appears after a mention, on by default, with the title prefilled and the button relabelled", () => {
    renderComposer()
    type("Can you draft this by Friday? @qu")
    pick("Quinn Morales")
    expect(screen.getByTestId("create-task-toggle")).toBeChecked()
    expect(screen.getByLabelText("Task title")).toHaveValue("Can you draft this by Friday")
    expect(screen.getByRole("button", { name: "Comment & create task" })).toBeEnabled()
  })

  it("unchecking sends a plain mention and reverts the label", async () => {
    renderComposer()
    type("Please look @qu")
    pick("Quinn Morales")
    fireEvent.click(screen.getByTestId("create-task-toggle"))
    expect(screen.queryByTestId("task-fields")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Comment" }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    expect(onSubmit.mock.calls[0][0].task).toBeNull()
    expect(parseMentions(onSubmit.mock.calls[0][0].body)[0]).toMatchObject({ kind: "user", id: QUINN })
  })

  it("posts the edited title, due date and priority with the first mention as assignee", async () => {
    renderComposer()
    type("Draft this @qu")
    pick("Quinn Morales")
    fireEvent.change(screen.getByLabelText("Task title"), { target: { value: "Draft rollout checklist" } })
    fireEvent.change(screen.getByLabelText("Due date"), { target: { value: "2026-10-23" } })
    fireEvent.change(screen.getByLabelText("Priority"), { target: { value: "HIGH" } })
    fireEvent.click(screen.getByRole("button", { name: "Comment & create task" }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    expect(onSubmit.mock.calls[0][0]).toMatchObject({
      task: { title: "Draft rollout checklist", dueDate: "2026-10-23", priority: "HIGH" },
      assignee: { kind: "user", id: QUINN },
      agentScopeConfirmed: false,
    })
  })

  it("shows assignee and watcher roles and can promote a watcher", async () => {
    renderComposer()
    type("with @qu")
    pick("Quinn Morales")
    // Continue typing after the chip's trailing space.
    const el = editor()
    const tail = document.createTextNode("and @que")
    el.appendChild(tail)
    const range = document.createRange()
    range.setStart(tail, tail.length)
    range.collapse(true)
    window.getSelection()!.removeAllRanges()
    window.getSelection()!.addRange(range)
    fireEvent.input(el)
    pick("Quentin Okafor")
    const roles = screen.getByTestId("mention-roles")
    expect(roles).toHaveTextContent("Assignee")
    expect(roles).toHaveTextContent("Watcher")
    fireEvent.click(screen.getByRole("button", { name: "Make assignee" }))
    fireEvent.click(screen.getByRole("button", { name: "Comment & create task" }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    expect(onSubmit.mock.calls[0][0].assignee).toEqual({ kind: "user", id: QUENTIN })
  })
})

describe("edge cases", () => {
  it("a first mention outside the workspace offers Invite / Mention only and creates no task", async () => {
    renderComposer()
    type("@dan")
    pick("Dana Whitfield")
    expect(screen.getByTestId("outside-workspace-alert")).toHaveTextContent("Dana Whitfield isn’t in this workspace")
    expect(screen.queryByTestId("create-task-toggle")).toBeNull()
    expect(screen.getByTestId("invite-as-viewer")).toBeDisabled()
    expect(screen.getByRole("button", { name: "Comment" })).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("mention-only"))
    fireEvent.click(screen.getByRole("button", { name: "Comment" }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    expect(onSubmit.mock.calls[0][0].task).toBeNull()
  })

  it("asks for a scope confirmation before the first assignment of an agent in a doc", async () => {
    renderComposer()
    type("Pull baselines @qa")
    pick("QA Agent")
    fireEvent.click(screen.getByRole("button", { name: "Comment & create task" }))
    expect(onSubmit).not.toHaveBeenCalled()
    const confirm = screen.getByTestId("agent-scope-confirm")
    expect(confirm).toHaveTextContent("QA Agent will receive")
    expect(confirm).toHaveTextContent("Its Write grant lets it reply in the thread")
    expect(confirm).toHaveTextContent("Nothing runs on its own")
    await act(async () => { fireEvent.click(screen.getByTestId("confirm-agent-assign")) })
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ assignee: { kind: "agent", id: BOT }, agentScopeConfirmed: true, task: expect.any(Object) })
  })

  it("skips the scope confirmation for an agent already confirmed in this doc", async () => {
    renderComposer({ confirmedAgentIds: [BOT] })
    type("Again @qa")
    pick("QA Agent")
    fireEvent.click(screen.getByRole("button", { name: "Comment & create task" }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    expect(screen.queryByTestId("agent-scope-confirm")).toBeNull()
  })

  it("surfaces a server rejection instead of swallowing it", async () => {
    onSubmit.mockResolvedValue({ ok: false, error: "FORBIDDEN", message: "x" })
    renderComposer()
    type("hello @qu")
    pick("Quinn Morales")
    fireEvent.click(screen.getByRole("button", { name: "Comment & create task" }))
    expect(await screen.findByTestId("composer-error")).toHaveTextContent("do not have permission")
  })
})
