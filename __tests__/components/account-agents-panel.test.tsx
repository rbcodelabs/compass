// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { AccountAgentsPanel } from "@/components/settings/account-agents-panel"

const { createAgent, updateAgent, createAgentKey, revokeAgentKey, requestAgentAccess, refresh } = vi.hoisted(() => ({
  createAgent: vi.fn(), updateAgent: vi.fn(), createAgentKey: vi.fn(), revokeAgentKey: vi.fn(), requestAgentAccess: vi.fn(), refresh: vi.fn(),
}))
vi.mock("@/app/settings/agents/actions", () => ({ createAgent, updateAgent, createAgentKey, revokeAgentKey, requestAgentAccess }))
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }))

const baseAgent = {
  id: "agent-1", name: "Ops Bot", description: null, status: "ACTIVE",
  keys: [], grants: [],
  requestable: [{ id: "ws-1", name: "Golden Wealth" }],
  pending: [],
}

afterEach(cleanup)
beforeEach(() => {
  vi.resetAllMocks()
  requestAgentAccess.mockResolvedValue({ id: "request-1" })
})

describe("AccountAgentsPanel — self-service access requests", () => {
  it("lists workspaces available to request and submits the chosen access level", async () => {
    render(<AccountAgentsPanel enabled agents={[baseAgent]} />)
    fireEvent.click(screen.getByRole("combobox", { name: "Workspace to request access to for Ops Bot" }))
    fireEvent.click(screen.getByRole("option", { name: "Golden Wealth" }))
    fireEvent.click(screen.getByRole("button", { name: "Request access" }))
    await waitFor(() => expect(requestAgentAccess).toHaveBeenCalledWith("agent-1", "ws-1", "READ"))
    await waitFor(() => expect(refresh).toHaveBeenCalled())
  })

  it("shows a pending request as awaiting approval, with no action available", () => {
    render(<AccountAgentsPanel enabled agents={[{ ...baseAgent, requestable: [], pending: [{ id: "req-1", workspaceId: "ws-1", name: "Golden Wealth", access: "WRITE" }] }]} />)
    expect(screen.getByText("Golden Wealth · Requested read and write — pending approval")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Request access" })).not.toBeInTheDocument()
  })

  it("shows nothing left to request once every workspace has a grant or pending request", () => {
    render(<AccountAgentsPanel enabled agents={[{ ...baseAgent, requestable: [] }]} />)
    expect(screen.getByText("No other workspaces available to request.")).toBeInTheDocument()
  })

  it("surfaces a rejected request as an alert instead of silently succeeding", async () => {
    requestAgentAccess.mockRejectedValue(new Error("This agent already has access to this workspace"))
    render(<AccountAgentsPanel enabled agents={[baseAgent]} />)
    fireEvent.click(screen.getByRole("combobox", { name: "Workspace to request access to for Ops Bot" }))
    fireEvent.click(screen.getByRole("option", { name: "Golden Wealth" }))
    fireEvent.click(screen.getByRole("button", { name: "Request access" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("This agent already has access to this workspace")
  })

  it("disables the request control for a suspended agent even when rollout is enabled", () => {
    render(<AccountAgentsPanel enabled agents={[{ ...baseAgent, status: "SUSPENDED" }]} />)
    expect(screen.getByRole("combobox", { name: "Workspace to request access to for Ops Bot" })).toBeDisabled()
  })

  it("disables the request control while rollout is globally disabled", () => {
    render(<AccountAgentsPanel enabled={false} agents={[baseAgent]} />)
    expect(screen.getByRole("combobox", { name: "Workspace to request access to for Ops Bot" })).toBeDisabled()
  })
})
