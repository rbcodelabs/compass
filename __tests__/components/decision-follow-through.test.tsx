// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest"
import { render, screen, cleanup, fireEvent } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"

const { createFollowUp, closeNoAction, refresh } = vi.hoisted(() => ({
  createFollowUp: vi.fn(), closeNoAction: vi.fn(), refresh: vi.fn(),
}))

vi.mock("@/app/[orgSlug]/[workspaceSlug]/reviews/actions", () => ({
  createFollowUpTaskAction: createFollowUp,
  closeDecisionNoActionAction: closeNoAction,
}))
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }))

import { DecisionFollowThrough } from "@/components/decisions/decision-follow-through"

const base = {
  workspaceId: "ws-1",
  requestId: "request-1",
  tasksBasePath: "/rbcodelabs/compass/tasks",
  tasks: [],
  assignees: [
    { type: "USER" as const, id: "user-1", displayName: "Rick" },
    { type: "AGENT" as const, id: "agent-1", displayName: "Delivery agent", ownerName: "Rick" },
  ],
  suggested: { assignee: { type: "AGENT" as const, id: "agent-1" }, provenance: "Suggested because Delivery agent raised this decision." },
  draft: { title: "Should we ship it?", description: "outcome: Approve" },
  noAction: null,
  canEdit: true,
}

afterEach(() => { cleanup(); vi.clearAllMocks() })

describe("DecisionFollowThrough", () => {
  it("says plainly when a decision has produced no work", () => {
    render(<DecisionFollowThrough {...base} />)
    expect(screen.getByText(/has not produced any work yet/i)).toBeInTheDocument()
  })

  it("lists produced work with its status and links to the task", () => {
    render(<DecisionFollowThrough {...base} tasks={[{ id: "task-1", title: "Ship the thing", status: "IN_PROGRESS" }]} />)
    expect(screen.getByText("IN PROGRESS")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Ship the thing" })).toHaveAttribute("href", "/rbcodelabs/compass/tasks/task-1")
  })

  it("prefills the draft title and shows the assignee suggestion's provenance", () => {
    render(<DecisionFollowThrough {...base} />)
    fireEvent.click(screen.getByRole("button", { name: /create follow-up/i }))
    expect(screen.getByLabelText("Title")).toHaveValue("Should we ship it?")
    expect(screen.getByText(/raised this decision/i)).toBeInTheDocument()
  })

  it("creates the follow-up with the suggested assignee by default", async () => {
    render(<DecisionFollowThrough {...base} />)
    fireEvent.click(screen.getByRole("button", { name: /create follow-up/i }))
    fireEvent.click(screen.getByRole("button", { name: /^create follow-up$/i }))
    await vi.waitFor(() => expect(createFollowUp).toHaveBeenCalledWith(expect.objectContaining({
      requestId: "request-1", assignee: { type: "AGENT", id: "agent-1" },
    })))
  })

  it("refuses to create a follow-up with an empty title", async () => {
    render(<DecisionFollowThrough {...base} draft={{ title: "", description: "" }} />)
    fireEvent.click(screen.getByRole("button", { name: /create follow-up/i }))
    fireEvent.click(screen.getByRole("button", { name: /^create follow-up$/i }))
    expect(await screen.findByRole("alert")).toHaveTextContent(/title/i)
    expect(createFollowUp).not.toHaveBeenCalled()
  })

  it("requires a reason before recording no action needed", async () => {
    render(<DecisionFollowThrough {...base} />)
    fireEvent.click(screen.getByRole("button", { name: /no action needed/i }))
    fireEvent.click(screen.getByRole("button", { name: /record no action needed/i }))
    expect(await screen.findByRole("alert")).toHaveTextContent(/why/i)
    expect(closeNoAction).not.toHaveBeenCalled()
  })

  it("shows the recorded reason once closed, and stops offering the close-out", () => {
    render(<DecisionFollowThrough {...base} noAction={{ reason: "Already handled upstream.", at: new Date() }} />)
    expect(screen.getByText(/Already handled upstream/)).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /no action needed/i })).not.toBeInTheDocument()
  })

  it("offers no write affordances to a member who cannot edit", () => {
    render(<DecisionFollowThrough {...base} canEdit={false} />)
    expect(screen.queryByRole("button", { name: /create follow-up/i })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /no action needed/i })).not.toBeInTheDocument()
  })

  it("does not offer the no-action close-out once work already exists", () => {
    render(<DecisionFollowThrough {...base} tasks={[{ id: "task-1", title: "Ship it", status: "TODO" }]} />)
    expect(screen.getByRole("button", { name: /create follow-up/i })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /no action needed/i })).not.toBeInTheDocument()
  })
})
