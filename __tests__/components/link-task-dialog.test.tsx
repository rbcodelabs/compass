// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { linkTaskMock } = vi.hoisted(() => ({ linkTaskMock: vi.fn() }))

vi.mock("@/app/[orgSlug]/[workspaceSlug]/tasks/actions", () => ({
  linkTask: linkTaskMock,
}))

import { LinkTaskDialog, type LinkableTargets } from "@/components/tasks/link-task-dialog"

const targets: LinkableTargets = {
  OPPORTUNITY: [
    { id: "shared", title: "Improve onboarding" },
    { id: "opp-2", title: "Reduce handoff friction" },
  ],
  SOLUTION: [{ id: "shared", title: "Onboarding checklist" }],
  ROADMAP_ITEM: [{ id: "road-1", title: "Self-serve activation" }],
  OBJECTIVE: [{ id: "obj-1", title: "Grow active teams" }],
  KEY_RESULT: [{ id: "kr-1", title: "Reach fifty active teams" }],
  DOC: [{ id: "doc-1", title: "Onboarding research" }],
  EXPERIMENT: [{ id: "exp-1", title: "Concierge onboarding test" }],
  FEEDBACK_ITEM: [{ id: "feedback-1", title: "Setup takes too long" }],
  DECISION: [{ id: "decision-1", title: "Choose guided setup" }],
}

function renderDialog(props: Partial<React.ComponentProps<typeof LinkTaskDialog>> = {}) {
  const onOpenChange = vi.fn()
  const onLinked = vi.fn()
  const result = render(
    <LinkTaskDialog
      taskId="task-1"
      open
      onOpenChange={onOpenChange}
      revalidatePathStr="/acme/product/tasks/task-1"
      linkableTargets={targets}
      onLinked={onLinked}
      {...props}
    />
  )
  return { ...result, onOpenChange, onLinked }
}

describe("LinkTaskDialog", () => {
  beforeEach(() => {
    linkTaskMock.mockReset()
    linkTaskMock.mockResolvedValue({ id: "link-1" })
    Element.prototype.scrollIntoView = vi.fn()
  })

  afterEach(() => cleanup())

  it("flattens all nine types with composite option ids and truthfully labels the initial list", () => {
    renderDialog()

    expect(screen.getByText("Available items")).toBeInTheDocument()
    expect(screen.getAllByRole("option")).toHaveLength(10)
    expect(screen.getByRole("option", { name: /Improve onboarding Opportunity/ })).toHaveAttribute("id", expect.stringContaining("OPPORTUNITY:shared"))
    expect(screen.getByRole("option", { name: /Onboarding checklist Solution/ })).toHaveAttribute("id", expect.stringContaining("SOLUTION:shared"))
    expect(screen.getAllByText("10 items")).toHaveLength(2)
  })

  it("searches titles case-insensitively and filters across every supported type", () => {
    renderDialog()
    const search = screen.getByRole("combobox", { name: "Search linkable items" })

    fireEvent.change(search, { target: { value: "ONBOARDING" } })
    expect(screen.getAllByRole("option")).toHaveLength(4)
    expect(screen.getAllByText("4 results")).toHaveLength(2)

    fireEvent.click(screen.getByRole("button", { name: "Docs" }))
    expect(screen.getAllByRole("option")).toHaveLength(1)
    expect(screen.getByRole("option", { name: /Onboarding research Doc/ })).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "More types" }))
    expect(screen.getByRole("button", { name: "Experiments" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Feedback items" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Decisions" })).toBeInTheDocument()
  })

  it("keeps a collapsed secondary filter visible on the More control", () => {
    renderDialog()

    fireEvent.click(screen.getByRole("button", { name: "More types" }))
    fireEvent.click(screen.getByRole("button", { name: "Decisions" }))
    fireEvent.click(screen.getByRole("button", { name: "More types" }))

    expect(screen.getByRole("button", { name: "More types, Decisions active" })).toHaveAttribute("aria-pressed", "true")
  })

  it("wraps keyboard navigation, exposes the active descendant, and Enter selects", () => {
    renderDialog()
    const search = screen.getByRole("combobox", { name: "Search linkable items" })

    fireEvent.keyDown(search, { key: "ArrowUp" })
    const last = screen.getAllByRole("option").at(-1)!
    expect(search).toHaveAttribute("aria-activedescendant", last.id)
    expect(last).toHaveAttribute("aria-selected", "false")

    fireEvent.keyDown(search, { key: "Enter" })
    expect(last).toHaveAttribute("aria-selected", "true")
    expect(screen.getByRole("button", { name: "Link item" })).toBeEnabled()
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled()
  })

  it("shows an honest preview and enables linking only after selection", () => {
    renderDialog()
    const linkButton = screen.getByRole("button", { name: "Link item" })
    expect(linkButton).toBeDisabled()
    expect(screen.getByText("Select an item")).toBeInTheDocument()

    fireEvent.click(screen.getByRole("option", { name: /Self-serve activation Roadmap Item/ }))
    expect(linkButton).toBeEnabled()
    const preview = screen.getByLabelText("Selected item preview")
    expect(within(preview).getByText("Self-serve activation")).toBeInTheDocument()
    expect(within(preview).getByText("Roadmap Item")).toBeInTheDocument()
    expect(within(preview).getByText(/current workspace/i)).toBeInTheDocument()
  })

  it("clears a selection when search or type filters hide it", () => {
    renderDialog()
    const search = screen.getByRole("combobox", { name: "Search linkable items" })
    const linkButton = screen.getByRole("button", { name: "Link item" })

    fireEvent.click(screen.getByRole("option", { name: /Onboarding checklist Solution/ }))
    fireEvent.change(search, { target: { value: "research" } })
    expect(linkButton).toBeDisabled()
    expect(screen.getByText("Select an item")).toBeInTheDocument()

    fireEvent.change(search, { target: { value: "" } })
    fireEvent.click(screen.getByRole("option", { name: /Self-serve activation Roadmap Item/ }))
    fireEvent.click(screen.getByRole("button", { name: "Docs" }))
    expect(linkButton).toBeDisabled()
    expect(screen.getByText("Select an item")).toBeInTheDocument()
  })

  it("calls linkTask with the selected composite target and resets after success", async () => {
    const { onOpenChange, onLinked, rerender } = renderDialog()
    fireEvent.click(screen.getByRole("option", { name: /Onboarding checklist Solution/ }))
    fireEvent.click(screen.getByRole("button", { name: "Link item" }))

    await waitFor(() => expect(linkTaskMock).toHaveBeenCalledWith("task-1", "SOLUTION", "shared", "/acme/product/tasks/task-1"))
    expect(onLinked).toHaveBeenCalledWith({ id: "link-1", linkedType: "SOLUTION", linkedId: "shared", linkedTitle: "Onboarding checklist" })
    expect(onOpenChange).toHaveBeenCalledWith(false)

    rerender(
      <LinkTaskDialog taskId="task-1" open={false} onOpenChange={onOpenChange} revalidatePathStr="/acme/product/tasks/task-1" linkableTargets={targets} onLinked={onLinked} />
    )
    rerender(
      <LinkTaskDialog taskId="task-1" open onOpenChange={onOpenChange} revalidatePathStr="/acme/product/tasks/task-1" linkableTargets={targets} onLinked={onLinked} />
    )
    expect(screen.getByRole("combobox", { name: "Search linkable items" })).toHaveValue("")
    expect(screen.getByRole("button", { name: "All item types" })).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByRole("button", { name: "Link item" })).toBeDisabled()
  })

  it("announces pending state, disables controls, and keeps an error open for retry", async () => {
    let reject!: (reason: Error) => void
    linkTaskMock.mockReturnValue(new Promise((_, nextReject) => { reject = nextReject }))
    const { onOpenChange } = renderDialog()
    fireEvent.click(screen.getByRole("option", { name: /Improve onboarding Opportunity/ }))
    fireEvent.click(screen.getByRole("button", { name: "Link item" }))

    expect(await screen.findByRole("status")).toHaveTextContent("Linking item")
    expect(screen.getByRole("combobox", { name: "Search linkable items" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Linking…" })).toBeDisabled()

    await act(async () => reject(new Error("network unavailable")))
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not link this item")
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
    expect(screen.getByRole("button", { name: "Link item" })).toBeEnabled()
  })

  it("shows no-match and no-items states", () => {
    const { rerender } = renderDialog()
    fireEvent.change(screen.getByRole("combobox", { name: "Search linkable items" }), { target: { value: "missing" } })
    expect(screen.getByText("No matches found")).toBeInTheDocument()

    const emptyTargets: LinkableTargets = {
      OPPORTUNITY: [], SOLUTION: [], ROADMAP_ITEM: [], OBJECTIVE: [], KEY_RESULT: [],
      DOC: [], EXPERIMENT: [], FEEDBACK_ITEM: [], DECISION: [],
    }
    rerender(
      <LinkTaskDialog taskId="task-1" open onOpenChange={vi.fn()} revalidatePathStr="/acme/product/tasks/task-1" linkableTargets={emptyTargets} onLinked={vi.fn()} />
    )
    expect(screen.getByText("No items available to link in this workspace.")).toBeInTheDocument()
  })

  it("caps the rendered result list and discloses the total", () => {
    const manyTargets: LinkableTargets = {
      ...targets,
      OPPORTUNITY: Array.from({ length: 80 }, (_, index) => ({ id: `opp-${index}`, title: `Opportunity ${index}` })),
    }
    renderDialog({ linkableTargets: manyTargets })

    expect(screen.getAllByRole("option")).toHaveLength(75)
    expect(screen.getByText("Showing 75 of 88")).toBeInTheDocument()
  })
})
