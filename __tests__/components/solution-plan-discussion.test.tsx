// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, describe, expect, it, vi } from "vitest"

const addSolutionComment = vi.fn()
const approveSolutionPlan = vi.fn()
const rejectSolutionPlan = vi.fn()
vi.mock("@/app/[orgSlug]/[workspaceSlug]/discovery/actions", () => ({
  addSolutionComment: (...args: unknown[]) => addSolutionComment(...args),
  approveSolutionPlan: (...args: unknown[]) => approveSolutionPlan(...args),
  rejectSolutionPlan: (...args: unknown[]) => rejectSolutionPlan(...args),
}))

import { SolutionPlanDiscussion } from "@/components/panels/solution-plan-discussion"
import type { SolutionComment } from "@/lib/types"

const plan: SolutionComment = {
  id: "plan-1", solutionId: "solution-1", commentType: "PLAN", body: "Keep the current plan",
  authorName: "Compass Agent", authorType: "AGENT", source: "MCP", planStatus: "PENDING",
  createdAt: "2026-09-04T12:00:00.000Z", updatedAt: "2026-09-04T12:00:00.000Z",
}
const ordinary: SolutionComment = { ...plan, id: "legacy-comment", commentType: "COMMENT", body: "Shown by shared Discussion" }

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("SolutionPlanDiscussion", () => {
  it("preserves current-plan decisions but excludes ordinary comments", async () => {
    approveSolutionPlan.mockResolvedValue(undefined)
    render(<SolutionPlanDiscussion solutionId="solution-1" comments={[ordinary, plan]} revalidatePathStr="/discovery" orgSlug="acme" workspaceSlug="product" />)

    expect(screen.getByTestId("current-plan")).toHaveTextContent("Keep the current plan")
    expect(screen.queryByText("Shown by shared Discussion")).toBeNull()
    expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled()
    expect(screen.getByRole("button", { name: "Reject" })).toBeEnabled()
    fireEvent.click(screen.getByRole("button", { name: "Approve" }))
    await waitFor(() => expect(approveSolutionPlan).toHaveBeenCalledWith("plan-1", "/discovery"))
    expect(screen.getByTestId("plan-status-badge")).toHaveTextContent("Approved")
  })

  it("creates only plan updates from the specialized composer", async () => {
    addSolutionComment.mockResolvedValue({ ...plan, id: "plan-2", body: "Next plan" })
    render(<SolutionPlanDiscussion solutionId="solution-1" comments={[]} revalidatePathStr="/discovery" orgSlug="acme" workspaceSlug="product" />)

    fireEvent.click(screen.getByRole("button", { name: "Add Plan Update" }))
    fireEvent.change(screen.getByPlaceholderText("Write a plan update…"), { target: { value: "Next plan" } })
    fireEvent.click(screen.getByRole("button", { name: "Post plan update" }))
    await waitFor(() => expect(addSolutionComment).toHaveBeenCalledWith("solution-1", { body: "Next plan", commentType: "PLAN" }, "/discovery"))
    expect(screen.getAllByText("Next plan").length).toBeGreaterThan(0)
  })

  it("shows a \"Send to agent\" link to the approved plan's hand-off route", () => {
    const approvedPlan: SolutionComment = { ...plan, planStatus: "APPROVED" }
    render(<SolutionPlanDiscussion solutionId="solution-1" comments={[approvedPlan]} revalidatePathStr="/discovery" orgSlug="acme" workspaceSlug="product" />)

    const link = screen.getByRole("link", { name: /send to agent/i })
    expect(link).toHaveAttribute("href", "/acme/product/agent?entityType=solutionPlan&entityId=plan-1")
  })

  it("hides \"Send to agent\" while the plan is still pending", () => {
    render(<SolutionPlanDiscussion solutionId="solution-1" comments={[plan]} revalidatePathStr="/discovery" orgSlug="acme" workspaceSlug="product" />)
    expect(screen.queryByRole("link", { name: /send to agent/i })).toBeNull()
  })

  it("hides \"Send to agent\" when the plan was rejected", () => {
    const rejectedPlan: SolutionComment = { ...plan, planStatus: "REJECTED" }
    render(<SolutionPlanDiscussion solutionId="solution-1" comments={[rejectedPlan]} revalidatePathStr="/discovery" orgSlug="acme" workspaceSlug="product" />)
    expect(screen.queryByRole("link", { name: /send to agent/i })).toBeNull()
  })
})
