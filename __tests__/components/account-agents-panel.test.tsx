// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const actions = vi.hoisted(() => ({
  createAgent: vi.fn(), updateAgent: vi.fn(), updateCloudAgent: vi.fn(), setMyDefaultAgentAction: vi.fn(), createAgentKey: vi.fn(), revokeAgentKey: vi.fn(), refresh: vi.fn(),
}))
vi.mock("@/app/settings/agents/actions", () => ({
  createAgent: actions.createAgent, updateAgent: actions.updateAgent, updateCloudAgent: actions.updateCloudAgent,
  setMyDefaultAgentAction: actions.setMyDefaultAgentAction, createAgentKey: actions.createAgentKey, revokeAgentKey: actions.revokeAgentKey,
}))
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: actions.refresh }) }))

import { AccountAgentsPanel } from "@/components/settings/account-agents-panel"

const models = [{ value: "claude-sonnet-5", label: "Claude Sonnet 5" }]
const cloud = {
  id: "c1", name: "Helper", description: null, status: "ACTIVE", keys: [], grants: [], kind: "CLOUD" as const, instructions: "Be brief.", model: null,
  workspaces: [
    { orgSlug: "acme", workspaceSlug: "home", name: "Home", enabled: true, isMyDefault: false },
    { orgSlug: "acme", workspaceSlug: "lab", name: "Lab", enabled: false, isMyDefault: false },
  ],
}
const external = { id: "e1", name: "CI bot", description: null, status: "ACTIVE", keys: [], grants: [] }

beforeEach(() => { vi.clearAllMocks(); for (const fn of Object.values(actions)) fn.mockResolvedValue(undefined) })
afterEach(cleanup)

describe("AccountAgentsPanel cloud agents", () => {
  it("shows a cloud agent with instructions to edit and no key generation, beside an external agent that keeps its keys", () => {
    render(<AccountAgentsPanel enabled agents={[cloud, external]} models={models} />)
    expect(screen.getByLabelText("Instructions")).toHaveValue("Be brief.")
    expect(screen.getAllByRole("button", { name: "Generate agent key" })).toHaveLength(1)
    expect(screen.queryByLabelText("Who can run this agent")).toBeNull()
  })

  it("saves edited instructions and model", async () => {
    render(<AccountAgentsPanel enabled agents={[cloud]} models={models} />)
    fireEvent.change(screen.getByLabelText("Instructions"), { target: { value: "Be thorough." } })
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "claude-sonnet-5" } })
    fireEvent.click(screen.getByRole("button", { name: "Save agent" }))
    await waitFor(() => expect(actions.updateCloudAgent).toHaveBeenCalledWith("c1", { name: "Helper", description: "", instructions: "Be thorough.", model: "claude-sonnet-5" }))
  })

  it("offers a personal default only in workspaces where the agent is enabled", async () => {
    render(<AccountAgentsPanel enabled agents={[cloud]} models={models} />)
    expect(screen.getByText(/Not enabled/)).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Use as my default in Lab" })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Use as my default in Home" }))
    await waitFor(() => expect(actions.setMyDefaultAgentAction).toHaveBeenCalledWith("acme", "home", "c1"))
  })

  it("clears an existing personal default", async () => {
    render(<AccountAgentsPanel enabled agents={[{ ...cloud, workspaces: [{ ...cloud.workspaces[0], isMyDefault: true }] }]} models={models} />)
    fireEvent.click(screen.getByRole("button", { name: "Clear my default in Home" }))
    await waitFor(() => expect(actions.setMyDefaultAgentAction).toHaveBeenCalledWith("acme", "home", null))
  })

  it("suspends a cloud agent", async () => {
    render(<AccountAgentsPanel enabled agents={[cloud]} models={models} />)
    fireEvent.click(screen.getByRole("button", { name: "Suspend" }))
    await waitFor(() => expect(actions.updateAgent).toHaveBeenCalledWith("c1", expect.objectContaining({ status: "SUSPENDED" })))
  })
})
