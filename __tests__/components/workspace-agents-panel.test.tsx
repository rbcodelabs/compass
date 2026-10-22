// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const actions = vi.hoisted(() => ({
  createCloudAgent: vi.fn(),
  grantWorkspaceAgent: vi.fn(),
  revokeWorkspaceAgent: vi.fn(),
  setMyDefaultAgentAction: vi.fn(),
  setWorkspaceDefaultAgentAction: vi.fn(),
  updateCloudAgent: vi.fn(),
  refresh: vi.fn(),
}))
vi.mock("@/app/settings/agents/actions", () => ({
  createCloudAgent: actions.createCloudAgent,
  grantWorkspaceAgent: actions.grantWorkspaceAgent,
  revokeWorkspaceAgent: actions.revokeWorkspaceAgent,
  setMyDefaultAgentAction: actions.setMyDefaultAgentAction,
  setWorkspaceDefaultAgentAction: actions.setWorkspaceDefaultAgentAction,
  updateCloudAgent: actions.updateCloudAgent,
}))
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: actions.refresh }) }))

import { WorkspaceAgentsPanel, type WorkspaceAgentRow } from "@/components/settings/workspace-agents-panel"

const models = [{ value: "claude-sonnet-5", label: "Claude Sonnet 5" }]
const shared: WorkspaceAgentRow = { id: "a-shared", name: "Triage", ownerName: "Shared", status: "ACTIVE", access: "READ", eligible: true, kind: "CLOUD", shared: true, canEdit: true, canUse: true, instructions: "Label feedback.", model: null, invokePolicy: "WORKSPACE_MEMBERS" }
const external: WorkspaceAgentRow = { id: "a-ext", name: "CI bot", ownerName: "Ada", status: "ACTIVE", access: "WRITE", eligible: true, kind: "EXTERNAL", shared: false }
const personal: WorkspaceAgentRow = { id: "a-mine", name: "Mine", ownerName: "Ada", status: "ACTIVE", access: "READ", eligible: true, kind: "CLOUD", shared: false, canEdit: true, canUse: true, instructions: "", model: "", invokePolicy: "OWNER" }

function renderPanel(agents: WorkspaceAgentRow[], props: Partial<{ canManage: boolean }> = {}) {
  return render(<WorkspaceAgentsPanel orgSlug="acme" workspaceSlug="home" agents={agents} canManage={props.canManage ?? false} models={models} />)
}

beforeEach(() => {
  vi.clearAllMocks()
  for (const fn of Object.values(actions)) fn.mockResolvedValue({ enabledInWorkspace: true })
})
afterEach(cleanup)

describe("WorkspaceAgentsPanel", () => {
  it("lists external and cloud agents with kind, owner and default badges", () => {
    renderPanel([{ ...shared, isWorkspaceDefault: true }, external, { ...personal, isMyDefault: true }])
    expect(screen.getAllByText("Cloud")).toHaveLength(2)
    expect(screen.getByText("External")).toBeInTheDocument()
    expect(screen.getAllByText("Shared").length).toBeGreaterThan(0)
    expect(screen.getAllByText("Personal")).toHaveLength(2)
    expect(screen.getAllByText("Workspace default").length).toBeGreaterThan(0)
    expect(screen.getByText("My default")).toBeInTheDocument()
  })

  it("wraps rows instead of squashing (no fixed-width table, no overflow clipping on the card)", () => {
    const { container } = renderPanel([shared])
    const row = container.querySelector("li")!
    expect(row.className).toContain("min-w-0")
    expect(row.className).not.toMatch(/overflow-hidden/)
    expect(container.querySelector("table")).toBeNull()
  })

  it("lets a member create a personal agent, but offers no shared owner type", async () => {
    renderPanel([])
    fireEvent.click(screen.getByRole("button", { name: "New cloud agent" }))
    const owner = screen.getByLabelText("Owner") as HTMLSelectElement
    expect([...owner.options].map((o) => o.value)).toEqual(["USER"])
    expect(screen.queryByLabelText("Access in this workspace")).toBeNull()
    fireEvent.change(screen.getByLabelText("Agent name"), { target: { value: "Helper" } })
    fireEvent.change(screen.getByLabelText("Instructions"), { target: { value: "Be brief." } })
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "claude-sonnet-5" } })
    actions.createCloudAgent.mockResolvedValue({ id: "new", enabledInWorkspace: false })
    fireEvent.click(screen.getByRole("button", { name: "Create agent" }))
    await waitFor(() => expect(actions.createCloudAgent).toHaveBeenCalledWith(expect.objectContaining({ orgSlug: "acme", workspaceSlug: "home", name: "Helper", instructions: "Be brief.", model: "claude-sonnet-5", ownerType: "USER" })))
    expect(await screen.findByText(/administrator needs to enable it/)).toBeInTheDocument()
    expect(actions.refresh).toHaveBeenCalled()
  })

  it("lets an admin create a shared agent with an invoke policy and access level", async () => {
    renderPanel([], { canManage: true })
    fireEvent.click(screen.getByRole("button", { name: "New cloud agent" }))
    fireEvent.change(screen.getByLabelText("Owner"), { target: { value: "WORKSPACE" } })
    fireEvent.change(screen.getByLabelText("Agent name"), { target: { value: "Ops" } })
    fireEvent.change(screen.getByLabelText("Who can run this agent"), { target: { value: "ADMINS" } })
    fireEvent.change(screen.getByLabelText("Access in this workspace"), { target: { value: "WRITE" } })
    fireEvent.click(screen.getByRole("button", { name: "Create agent" }))
    await waitFor(() => expect(actions.createCloudAgent).toHaveBeenCalledWith(expect.objectContaining({ ownerType: "WORKSPACE", invokePolicy: "ADMINS", access: "WRITE" })))
    expect(await screen.findByText("Agent created and enabled in this workspace.")).toBeInTheDocument()
  })

  it("edits instructions, model and policy of a shared agent", async () => {
    renderPanel([shared], { canManage: true })
    fireEvent.click(screen.getByRole("button", { name: "Edit Triage" }))
    fireEvent.change(screen.getByLabelText("Instructions"), { target: { value: "New instructions" } })
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "claude-sonnet-5" } })
    fireEvent.change(screen.getByLabelText("Who can run this agent"), { target: { value: "ADMINS" } })
    fireEvent.click(screen.getByRole("button", { name: "Save agent" }))
    await waitFor(() => expect(actions.updateCloudAgent).toHaveBeenCalledWith("a-shared", { name: "Triage", description: "", instructions: "New instructions", model: "claude-sonnet-5", invokePolicy: "ADMINS" }))
  })

  it("shows the stored run limits in the edit form, and sends only the ones that changed", async () => {
    renderPanel([{ ...shared, maxConcurrentRuns: 3, maxRunsPerDay: null }], { canManage: true })
    fireEvent.click(screen.getByRole("button", { name: "Edit Triage" }))
    expect(screen.getByLabelText("Concurrent run limit")).toHaveValue(3)
    expect(screen.getByLabelText("Daily run limit")).toHaveValue(null)
    expect(screen.getByLabelText("Daily run limit")).toHaveAttribute("placeholder", "100 (default)")
    fireEvent.change(screen.getByLabelText("Daily run limit"), { target: { value: "25" } })
    fireEvent.click(screen.getByRole("button", { name: "Save agent" }))
    await waitFor(() => expect(actions.updateCloudAgent).toHaveBeenCalled())
    const input = actions.updateCloudAgent.mock.calls[0][1]
    expect(input.maxRunsPerDay).toBe(25)
    expect(input).not.toHaveProperty("maxConcurrentRuns")
  })

  it("clears a limit back to the default by emptying the field", async () => {
    renderPanel([{ ...shared, maxConcurrentRuns: 3 }], { canManage: true })
    fireEvent.click(screen.getByRole("button", { name: "Edit Triage" }))
    fireEvent.change(screen.getByLabelText("Concurrent run limit"), { target: { value: "" } })
    fireEvent.click(screen.getByRole("button", { name: "Save agent" }))
    await waitFor(() => expect(actions.updateCloudAgent).toHaveBeenCalled())
    expect(actions.updateCloudAgent.mock.calls[0][1].maxConcurrentRuns).toBeNull()
  })

  it("does not offer run limits on the create form", () => {
    renderPanel([shared], { canManage: true })
    fireEvent.click(screen.getByRole("button", { name: "New cloud agent" }))
    expect(screen.queryByLabelText("Concurrent run limit")).toBeNull()
  })

  it("shows no invoke policy and sends none when editing a personal agent", async () => {
    renderPanel([personal])
    fireEvent.click(screen.getByRole("button", { name: "Edit Mine" }))
    expect(screen.queryByLabelText("Who can run this agent")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Save agent" }))
    await waitFor(() => expect(actions.updateCloudAgent).toHaveBeenCalled())
    expect(actions.updateCloudAgent.mock.calls[0][1]).not.toHaveProperty("invokePolicy")
  })

  it("offers Edit only for agents the viewer may edit", () => {
    renderPanel([{ ...shared, canEdit: false }, external])
    expect(screen.queryByRole("button", { name: /^Edit / })).toBeNull()
  })

  it("sets and clears the personal default for an agent the viewer can use", async () => {
    renderPanel([shared])
    fireEvent.click(screen.getByRole("button", { name: "Use as my default" }))
    await waitFor(() => expect(actions.setMyDefaultAgentAction).toHaveBeenCalledWith("acme", "home", "a-shared"))
    cleanup()
    renderPanel([{ ...shared, isMyDefault: true }])
    fireEvent.click(screen.getByRole("button", { name: "Clear my default" }))
    await waitFor(() => expect(actions.setMyDefaultAgentAction).toHaveBeenCalledWith("acme", "home", null))
  })

  it("offers no personal default for an agent the viewer cannot use", () => {
    renderPanel([{ ...shared, canUse: false }])
    expect(screen.queryByRole("button", { name: /my default/i })).toBeNull()
  })

  it("offers the workspace default to admins only, and only for shared agents", async () => {
    renderPanel([shared, personal], { canManage: false })
    expect(screen.queryByRole("button", { name: /workspace default/i })).toBeNull()
    cleanup()
    renderPanel([shared, personal], { canManage: true })
    const buttons = screen.getAllByRole("button", { name: "Set as workspace default" })
    expect(buttons).toHaveLength(1)
    fireEvent.click(buttons[0])
    await waitFor(() => expect(actions.setWorkspaceDefaultAgentAction).toHaveBeenCalledWith("acme", "home", "a-shared"))
  })

  it("surfaces an action failure", async () => {
    actions.setMyDefaultAgentAction.mockRejectedValue(new Error("You are not allowed to run this agent."))
    renderPanel([shared])
    fireEvent.click(screen.getByRole("button", { name: "Use as my default" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("not allowed to run this agent")
  })
})
