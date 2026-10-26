// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const m = vi.hoisted(() => ({ createCloudAgent: vi.fn(), updateCloudAgent: vi.fn(), updateDeveloperSandboxEnabled: vi.fn(), refresh: vi.fn() }))
vi.mock("@/app/settings/agents/actions", () => ({
  createCloudAgent: m.createCloudAgent, grantWorkspaceAgent: vi.fn(), revokeWorkspaceAgent: vi.fn(),
  setMyDefaultAgentAction: vi.fn(), setWorkspaceDefaultAgentAction: vi.fn(), updateCloudAgent: m.updateCloudAgent,
}))
vi.mock("@/app/[orgSlug]/[workspaceSlug]/settings/actions", () => ({ updateDeveloperSandboxEnabled: m.updateDeveloperSandboxEnabled }))
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: m.refresh }) }))

import { WorkspaceAgentsPanel, type WorkspaceAgentRow } from "@/components/settings/workspace-agents-panel"
import { AgentDeveloperSandboxPanel } from "@/components/settings/agent-developer-sandbox-panel"

const shared: WorkspaceAgentRow = { id: "a1", name: "Builder", ownerName: "Shared", status: "ACTIVE", access: "READ", eligible: true, kind: "CLOUD", shared: true, canEdit: true, canUse: true, instructions: "Build things.", model: null, invokePolicy: "WORKSPACE_MEMBERS", sandboxClass: "STANDARD" }
const personal: WorkspaceAgentRow = { ...shared, id: "a2", name: "Mine", shared: false, invokePolicy: "OWNER" }

beforeEach(() => {
  vi.clearAllMocks()
  m.updateCloudAgent.mockResolvedValue(undefined)
  m.createCloudAgent.mockResolvedValue({ id: "new", enabledInWorkspace: true })
  m.updateDeveloperSandboxEnabled.mockImplementation(async (_o: string, _w: string, enabled: boolean) => ({ ok: true, enabled }))
})
afterEach(cleanup)

const panel = (agent: WorkspaceAgentRow, developerSandboxEnabled: boolean) =>
  render(<WorkspaceAgentsPanel orgSlug="acme" workspaceSlug="home" agents={[agent]} canManage models={[]} developerSandboxEnabled={developerSandboxEnabled} />)

describe("agent sandbox picker", () => {
  it("offers Developer only as a disabled option, with a hint, while the workspace has it off", () => {
    panel(shared, false)
    fireEvent.click(screen.getByRole("button", { name: "Edit Builder" }))
    expect(screen.getByTestId("agent-sandbox-class")).toHaveValue("STANDARD")
    expect(screen.getByRole("option", { name: /Developer/ })).toBeDisabled()
    expect(screen.getByText(/turned off for this workspace/)).toBeInTheDocument()
  })

  it("is hidden for a personal agent even when enabled", () => {
    panel(personal, true)
    fireEvent.click(screen.getByRole("button", { name: "Edit Mine" }))
    expect(screen.queryByTestId("agent-sandbox-class")).toBeNull()
  })

  it("saves a changed class, and sends nothing when it is left alone", async () => {
    panel(shared, true)
    fireEvent.click(screen.getByRole("button", { name: "Edit Builder" }))
    fireEvent.click(screen.getByRole("button", { name: "Save agent" }))
    await waitFor(() => expect(m.updateCloudAgent).toHaveBeenCalledTimes(1))
    expect(m.updateCloudAgent.mock.calls[0][1]).not.toHaveProperty("sandboxClass")
    await waitFor(() => expect(screen.queryByRole("button", { name: "Save agent" })).toBeNull())
    await waitFor(() => expect(screen.getByRole("button", { name: "Edit Builder" })).toBeEnabled())

    fireEvent.click(screen.getByRole("button", { name: "Edit Builder" }))
    fireEvent.change(screen.getByTestId("agent-sandbox-class"), { target: { value: "DEVELOPER" } })
    fireEvent.click(screen.getByRole("button", { name: "Save agent" }))
    await waitFor(() => expect(m.updateCloudAgent).toHaveBeenCalledTimes(2))
    expect(m.updateCloudAgent.mock.calls[1][1]).toMatchObject({ sandboxClass: "DEVELOPER" })
  })

  it("warns that a DEVELOPER agent is refused while the workspace has the sandbox off", () => {
    panel({ ...shared, sandboxClass: "DEVELOPER" }, false)
    fireEvent.click(screen.getByRole("button", { name: "Edit Builder" }))
    expect(screen.getByTestId("agent-sandbox-class")).toHaveValue("DEVELOPER")
    expect(screen.getByText(/turned off for this workspace/)).toBeInTheDocument()
  })
})

describe("new agent form", () => {
  const openCreate = () => {
    panel(shared, true)
    fireEvent.click(screen.getByRole("button", { name: "New cloud agent" }))
  }

  it("lets a shared agent be created on the developer sandbox", async () => {
    openCreate()
    fireEvent.change(screen.getByLabelText("Owner"), { target: { value: "WORKSPACE" } })
    fireEvent.change(screen.getByLabelText("Agent name"), { target: { value: "Dev bot" } })
    fireEvent.change(screen.getByTestId("agent-sandbox-class"), { target: { value: "DEVELOPER" } })
    fireEvent.submit(screen.getByRole("form", { name: "New cloud agent" }))
    await waitFor(() => expect(m.createCloudAgent).toHaveBeenCalledTimes(1))
    expect(m.createCloudAgent.mock.calls[0][0]).toMatchObject({ ownerType: "WORKSPACE", sandboxClass: "DEVELOPER" })
  })

  it("sends no class for a standard agent, and shows no picker for a personal one", async () => {
    openCreate()
    expect(screen.queryByTestId("agent-sandbox-class")).toBeNull()
    expect(screen.getByText(/Personal agents run in the standard sandbox/)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText("Owner"), { target: { value: "WORKSPACE" } })
    fireEvent.change(screen.getByLabelText("Agent name"), { target: { value: "Plain" } })
    fireEvent.submit(screen.getByRole("form", { name: "New cloud agent" }))
    await waitFor(() => expect(m.createCloudAgent).toHaveBeenCalledTimes(1))
    expect(m.createCloudAgent.mock.calls[0][0]).not.toHaveProperty("sandboxClass")
  })
})

describe("AgentDeveloperSandboxPanel", () => {
  it("saves the toggle through the admin action", async () => {
    render(<AgentDeveloperSandboxPanel orgSlug="acme" workspaceSlug="home" initialEnabled={false} canEdit />)
    expect(screen.getByTestId("agent-developer-sandbox-save")).toBeDisabled()
    fireEvent.click(screen.getByTestId("agent-developer-sandbox-input"))
    fireEvent.click(screen.getByTestId("agent-developer-sandbox-save"))
    await waitFor(() => expect(m.updateDeveloperSandboxEnabled).toHaveBeenCalledWith("acme", "home", true))
    expect(await screen.findByTestId("agent-developer-sandbox-notice")).toHaveTextContent(/can now use the developer sandbox/)
  })

  it("is read-only for non-admins", () => {
    render(<AgentDeveloperSandboxPanel orgSlug="acme" workspaceSlug="home" initialEnabled canEdit={false} />)
    expect(screen.getByTestId("agent-developer-sandbox-readonly")).toHaveTextContent(/enabled/)
    expect(screen.queryByTestId("agent-developer-sandbox-input")).toBeNull()
  })
})
