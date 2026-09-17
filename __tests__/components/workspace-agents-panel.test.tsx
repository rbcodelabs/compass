// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { WorkspaceAgentsPanel } from "@/components/settings/workspace-agents-panel"

const { grantWorkspaceAgent, revokeWorkspaceAgent, approveAgentAccessRequest, denyAgentAccessRequest, refresh } = vi.hoisted(() => ({
  grantWorkspaceAgent: vi.fn(), revokeWorkspaceAgent: vi.fn(), approveAgentAccessRequest: vi.fn(), denyAgentAccessRequest: vi.fn(), refresh: vi.fn(),
}))
vi.mock("@/app/settings/agents/actions", () => ({ grantWorkspaceAgent, revokeWorkspaceAgent, approveAgentAccessRequest, denyAgentAccessRequest }))
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }))

const pendingRequest = { id: "req-1", agentName: "Ops Bot", ownerName: "Alex", access: "WRITE" }

afterEach(cleanup)
beforeEach(() => {
  vi.resetAllMocks()
  approveAgentAccessRequest.mockResolvedValue(undefined)
  denyAgentAccessRequest.mockResolvedValue(undefined)
})

describe("WorkspaceAgentsPanel — admin approval of self-service requests", () => {
  it("shows a pending request with the requesting agent, owner, and access level", () => {
    render(<WorkspaceAgentsPanel orgSlug="org" workspaceSlug="ws" canManage enabled agents={[]} pendingRequests={[pendingRequest]} />)
    expect(screen.getByText("Ops Bot")).toBeInTheDocument()
    expect(screen.getByText("Alex · requested read and write")).toBeInTheDocument()
  })

  it("approves a pending request and refreshes", async () => {
    render(<WorkspaceAgentsPanel orgSlug="org" workspaceSlug="ws" canManage enabled agents={[]} pendingRequests={[pendingRequest]} />)
    fireEvent.click(screen.getByRole("button", { name: "Approve access request from Ops Bot" }))
    await waitFor(() => expect(approveAgentAccessRequest).toHaveBeenCalledWith("req-1"))
    await waitFor(() => expect(refresh).toHaveBeenCalled())
  })

  it("denies a pending request and refreshes", async () => {
    render(<WorkspaceAgentsPanel orgSlug="org" workspaceSlug="ws" canManage enabled agents={[]} pendingRequests={[pendingRequest]} />)
    fireEvent.click(screen.getByRole("button", { name: "Deny access request from Ops Bot" }))
    await waitFor(() => expect(denyAgentAccessRequest).toHaveBeenCalledWith("req-1"))
    await waitFor(() => expect(refresh).toHaveBeenCalled())
  })

  it("hides pending requests and their actions from a non-admin member", () => {
    render(<WorkspaceAgentsPanel orgSlug="org" workspaceSlug="ws" canManage={false} enabled agents={[]} pendingRequests={[pendingRequest]} />)
    expect(screen.queryByText("Pending access requests")).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Approve access request from Ops Bot" })).not.toBeInTheDocument()
  })

  it("renders no pending-requests section when there are none", () => {
    render(<WorkspaceAgentsPanel orgSlug="org" workspaceSlug="ws" canManage enabled agents={[]} pendingRequests={[]} />)
    expect(screen.queryByText("Pending access requests")).not.toBeInTheDocument()
  })

  it("surfaces an approval failure as an alert", async () => {
    approveAgentAccessRequest.mockRejectedValue(new Error("Forbidden: workspace admin required"))
    render(<WorkspaceAgentsPanel orgSlug="org" workspaceSlug="ws" canManage enabled agents={[]} pendingRequests={[pendingRequest]} />)
    fireEvent.click(screen.getByRole("button", { name: "Approve access request from Ops Bot" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("Forbidden: workspace admin required")
  })
})
