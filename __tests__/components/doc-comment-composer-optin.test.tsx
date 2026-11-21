// @vitest-environment jsdom
//
// TASK-195 S4 review: the task row as an opt-in (defaultTaskOn=false), with the REAL mention editor, so Enter semantics are
// the editor's own and not a mock's. Also the built-in agent exclusion and the non-Doc run copy.
import * as React from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { DocCommentComposer } from "@/components/docs/doc-comment-composer"
import type { MentionOptions } from "@/components/docs/mention-editor"

const QUINN = "6f1c2a40-1111-4222-8333-944455556666"
const BOT = "8b1c2a40-1111-4222-8333-944455556668"
const BUILTIN = "00000000-0000-4000-8000-000000000001"
const options: MentionOptions = {
  people: [{ kind: "user", id: QUINN, name: "Quinn Morales", detail: "quinn@example.com" }],
  agents: [
    { kind: "agent", id: BUILTIN, name: "Compass Agent", detail: "Workspace AI assistant", access: "WRITE", agentKind: "CLOUD" },
    { kind: "agent", id: BOT, name: "QA Agent", detail: "Test plans", access: "WRITE", agentKind: "CLOUD" },
  ],
  outside: [],
}
const onSubmit = vi.fn()
const editor = () => screen.getByRole("textbox", { name: "Start" })

function type(text: string) {
  const el = editor()
  el.textContent = text
  const range = document.createRange()
  range.setStart(el.firstChild as Text, text.length)
  range.collapse(true)
  const selection = window.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
  fireEvent.input(el)
}
function mention(name: string) {
  type("hello @" + name.slice(0, 4))
  fireEvent.click(screen.getAllByTestId("mention-option").find((o) => o.getAttribute("data-mention-name") === name)!)
}
function renderComposer(extra: Partial<React.ComponentProps<typeof DocCommentComposer>> = {}) {
  return render(
    <DocCommentComposer options={options} confirmedAgentIds={[]} docTitle="Item" targetNoun="item" ariaLabel="Start" idleLabel="Send"
      defaultTaskOn={false} excludedAssigneeIds={[BUILTIN]} submitOnEnter onSubmit={onSubmit} {...extra} />,
  )
}

beforeEach(() => {
  vi.resetAllMocks()
  onSubmit.mockResolvedValue({ ok: true })
  document.execCommand = vi.fn(() => true)
  Element.prototype.scrollIntoView = vi.fn()
})
afterEach(cleanup)

describe("task row as an opt-in", () => {
  it("starts with the task off: the button is Send and Enter sends a plain post with no task", async () => {
    renderComposer()
    mention("Quinn Morales")
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled()
    expect(screen.queryByTestId("task-fields")).toBeNull()
    fireEvent.keyDown(editor(), { key: "Enter" })
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ task: null })
  })

  it("after the opt-in the button creates the task and plain Enter no longer sends", async () => {
    renderComposer()
    mention("Quinn Morales")
    fireEvent.click(screen.getByTestId("create-task-toggle"))
    fireEvent.keyDown(editor(), { key: "Enter" })
    expect(onSubmit).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Comment & create task" }))
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ task: { priority: "MEDIUM" }, assignee: { kind: "user", id: QUINN } })
  })

  it("never treats an excluded agent as the assignee: no task box for it alone", () => {
    renderComposer()
    mention("Compass Agent")
    expect(screen.queryByTestId("comment-task-box")).toBeNull()
    expect(screen.queryByTestId("outside-workspace-alert")).toBeNull()
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled()
  })

  it("keeps the default (task on) for hosts that do not opt out", () => {
    renderComposer({ defaultTaskOn: undefined, excludedAssigneeIds: undefined })
    mention("Quinn Morales")
    expect(screen.getByRole("button", { name: "Comment & create task" })).toBeEnabled()
  })

  it("does not claim a run starts when the host's path starts none", () => {
    renderComposer({ defaultTaskOn: true })
    mention("QA Agent")
    fireEvent.click(screen.getByRole("button", { name: "Comment & create task" }))
    expect(screen.getByTestId("agent-scope-confirm")).not.toHaveTextContent(/starts a run|run started/i)
  })

  it("lets the host replace the toggle hint", () => {
    renderComposer({ taskToggleHint: "Leave off to post a plain message." })
    mention("Quinn Morales")
    expect(screen.getByTestId("comment-task-box")).toHaveTextContent("Leave off to post a plain message.")
  })
})
