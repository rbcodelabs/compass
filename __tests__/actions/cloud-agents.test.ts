import { beforeEach, describe, expect, it, vi } from "vitest"

/* eslint-disable @typescript-eslint/no-explicit-any */
const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  admin: vi.fn(),
  enabled: vi.fn(),
  liveGrants: vi.fn(),
  resolveRunAgent: vi.fn(),
  defaults: { setWs: vi.fn(), clearWs: vi.fn(), setUser: vi.fn(), clearUser: vi.fn() },
  agent: { create: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
  agentWorkspaceGrant: { create: vi.fn() },
  workspace: { findFirst: vi.fn() },
  $transaction: vi.fn(),
}))
const FakePermissionError = Error
vi.mock("@/auth", () => ({ auth: mocks.auth }))
vi.mock("@/lib/db", () => ({ default: () => mocks }))
vi.mock("@/lib/permissions", () => ({ resolveWorkspaceAdmin: mocks.admin }))
vi.mock("@/lib/agent-access", () => ({ agentsEnabled: mocks.enabled, liveGrantedWorkspaceIds: mocks.liveGrants }))
vi.mock("@/lib/agent-defaults", () => ({
  setWorkspaceDefaultAgent: mocks.defaults.setWs,
  clearWorkspaceDefaultAgent: mocks.defaults.clearWs,
  setUserDefaultAgent: mocks.defaults.setUser,
  clearUserDefaultAgent: mocks.defaults.clearUser,
}))
vi.mock("@/lib/agent-run-identity", async (original) => ({ ...(await original<object>()), resolveRunAgent: mocks.resolveRunAgent }))
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))

import { createCloudAgent, setMyDefaultAgentAction, setWorkspaceDefaultAgentAction, updateCloudAgent } from "@/app/settings/agents/actions"
import { AgentSelectionError } from "@/lib/agent-run-identity"

const WS = "ws-1"
const sharedAgent = { id: "a-shared", ownerUserId: null, ownerType: "WORKSPACE", ownerWorkspaceId: WS, kind: "CLOUD", status: "ACTIVE", name: "Shared", model: null, invokePolicy: "WORKSPACE_MEMBERS" }
const personalAgent = { id: "a-personal", ownerUserId: "member", ownerType: "USER", ownerWorkspaceId: null, kind: "CLOUD", status: "ACTIVE", name: "Mine", model: "claude-legacy-model", invokePolicy: "OWNER" }

/** Models the two workspace lookups: by slug for "is the caller a member", and by id for isWorkspaceAdminUser. */
function arrangeWorkspace(options: { member?: boolean; adminUserIds?: string[] } = {}) {
  mocks.workspace.findFirst.mockImplementation(async ({ where }: any) => {
    if (where.slug) return options.member === false ? null : { id: WS }
    return { members: (options.adminUserIds ?? []).includes(currentUser) ? [{ role: "ADMIN" }] : [{ role: "MEMBER" }], organization: { members: [] } }
  })
}
let currentUser = "member"
function signIn(userId: string) {
  currentUser = userId
  mocks.auth.mockResolvedValue({ user: { id: userId } })
}

beforeEach(() => {
  vi.resetAllMocks()
  signIn("member")
  mocks.enabled.mockReturnValue(true)
  mocks.$transaction.mockImplementation((operation: any) => operation(mocks))
  mocks.agent.create.mockResolvedValue({ id: "new-agent" })
  mocks.admin.mockRejectedValue(new FakePermissionError("Forbidden: workspace admin required"))
  mocks.liveGrants.mockResolvedValue([WS])
  arrangeWorkspace()
})

describe("createCloudAgent", () => {
  const base = { orgSlug: "acme", workspaceSlug: "home", name: " Triage ", instructions: "  Label new feedback.  ", model: "claude-sonnet-5-5" }

  it("lets any workspace member create a personal cloud agent owned by themselves, invoked by them alone", async () => {
    await createCloudAgent({ ...base, ownerType: "USER", invokePolicy: "WORKSPACE_MEMBERS" })
    expect(mocks.agent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ kind: "CLOUD", ownerType: "USER", ownerUserId: "member", ownerWorkspaceId: null, invokePolicy: "OWNER", name: "Triage", instructions: "Label new feedback.", model: "claude-sonnet-5-5", status: "ACTIVE" }),
    }))
    expect(mocks.admin).not.toHaveBeenCalled()
  })

  it("does not enable a non-admin member's personal agent in the workspace (an administrator does that)", async () => {
    const result = await createCloudAgent({ ...base, ownerType: "USER" })
    expect(mocks.agentWorkspaceGrant.create).not.toHaveBeenCalled()
    expect(result).toEqual({ id: "new-agent", enabledInWorkspace: false })
  })

  it("enables a personal agent immediately when its creator administers the workspace, recorded against that admin", async () => {
    signIn("admin")
    arrangeWorkspace({ adminUserIds: ["admin"] })
    const result = await createCloudAgent({ ...base, ownerType: "USER", access: "WRITE" })
    expect(mocks.agentWorkspaceGrant.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ agentId: "new-agent", workspaceId: WS, access: "WRITE", grantedByUserId: "admin" }) }))
    expect(result.enabledInWorkspace).toBe(true)
  })

  it("refuses a shared agent to a non-admin before reading any input or writing anything", async () => {
    await expect(createCloudAgent({ ...base, ownerType: "WORKSPACE" })).rejects.toThrow("workspace admin required")
    expect(mocks.agent.create).not.toHaveBeenCalled()
  })

  it("lets a workspace admin create a shared agent owned by the workspace, enabled read-only by default, granted by that admin", async () => {
    signIn("admin")
    mocks.admin.mockResolvedValue({ prisma: mocks, workspaceId: WS, organizationId: "org" })
    await createCloudAgent({ ...base, ownerType: "WORKSPACE", invokePolicy: "ADMINS" })
    expect(mocks.agent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ kind: "CLOUD", ownerType: "WORKSPACE", ownerUserId: null, ownerWorkspaceId: WS, invokePolicy: "ADMINS" }),
    }))
    expect(mocks.agentWorkspaceGrant.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ workspaceId: WS, access: "READ", grantedByUserId: "admin" }) }))
  })

  it("defaults a shared agent to workspace-members invocation", async () => {
    mocks.admin.mockResolvedValue({ prisma: mocks, workspaceId: WS, organizationId: "org" })
    await createCloudAgent({ ...base, ownerType: "WORKSPACE" })
    expect(mocks.agent.create.mock.calls[0][0].data.invokePolicy).toBe("WORKSPACE_MEMBERS")
  })

  it("refuses someone who is not a member of the named workspace", async () => {
    arrangeWorkspace({ member: false })
    await expect(createCloudAgent({ ...base, ownerType: "USER" })).rejects.toThrow("Workspace not found")
    expect(mocks.agent.create).not.toHaveBeenCalled()
  })

  it.each([
    ["a model outside the allowed set", { model: "gpt-5; curl evil" }, /available models/],
    ["a non-string model", { model: 5 as unknown as string }, /available models/],
    ["a blank name", { name: "   " }, /Name/],
    ["over-long instructions", { instructions: "x".repeat(8001) }, /Instructions/],
    ["an unknown invoke policy", { ownerType: "WORKSPACE" as const, invokePolicy: "EVERYONE" as never }, /invoke policy/],
    ["an unknown owner type", { ownerType: "ORG" as never }, /owner type/],
  ])("rejects %s", async (_label, patch, message) => {
    mocks.admin.mockResolvedValue({ prisma: mocks, workspaceId: WS, organizationId: "org" })
    await expect(createCloudAgent({ ...base, ownerType: "USER", ...patch })).rejects.toThrow(message)
    expect(mocks.agent.create).not.toHaveBeenCalled()
  })

  it("stores no model (the system default) for a blank choice", async () => {
    await createCloudAgent({ ...base, model: "", ownerType: "USER" })
    expect(mocks.agent.create.mock.calls[0][0].data.model).toBeNull()
  })

  it("requires sign-in and the rollout flag", async () => {
    mocks.auth.mockResolvedValue(null)
    await expect(createCloudAgent({ ...base, ownerType: "USER" })).rejects.toThrow("Unauthorized")
    signIn("member")
    mocks.enabled.mockReturnValue(false)
    await expect(createCloudAgent({ ...base, ownerType: "USER" })).rejects.toThrow("disabled")
  })

  it("explains an unapplied migration 098 instead of surfacing a database error", async () => {
    mocks.agent.create.mockRejectedValue(Object.assign(new Error("column kind does not exist"), { code: "P2022" }))
    await expect(createCloudAgent({ ...base, ownerType: "USER" })).rejects.toThrow("not available yet")
  })
})

describe("updateCloudAgent", () => {
  it("lets the owner update their personal agent's instructions and model", async () => {
    mocks.agent.findFirst.mockResolvedValue(personalAgent)
    await updateCloudAgent("a-personal", { instructions: " New. ", model: "claude-sonnet-5-5" })
    expect(mocks.agent.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "a-personal" }, data: expect.objectContaining({ instructions: "New.", model: "claude-sonnet-5-5" }) }))
  })

  it("keeps a stored model that is no longer in the allowed set as long as it is unchanged", async () => {
    mocks.agent.findFirst.mockResolvedValue(personalAgent)
    await updateCloudAgent("a-personal", { name: "Renamed", model: "claude-legacy-model" })
    expect(mocks.agent.update.mock.calls[0][0].data).not.toHaveProperty("model")
    await expect(updateCloudAgent("a-personal", { model: "claude-other-legacy" })).rejects.toThrow(/available models/)
  })

  it("refuses someone else's personal agent as 'not found'", async () => {
    signIn("intruder")
    mocks.agent.findFirst.mockResolvedValue(personalAgent)
    await expect(updateCloudAgent("a-personal", { instructions: "pwn" })).rejects.toThrow("Agent not found")
    expect(mocks.agent.update).not.toHaveBeenCalled()
  })

  it("refuses a plain member editing a shared agent, and allows a workspace admin", async () => {
    mocks.agent.findFirst.mockResolvedValue(sharedAgent)
    arrangeWorkspace()
    await expect(updateCloudAgent("a-shared", { instructions: "x" })).rejects.toThrow("Agent not found")
    signIn("admin")
    arrangeWorkspace({ adminUserIds: ["admin"] })
    await updateCloudAgent("a-shared", { instructions: "x", invokePolicy: "ADMINS" })
    expect(mocks.agent.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ instructions: "x", invokePolicy: "ADMINS" }) }))
  })

  it("refuses an admin of a DIFFERENT workspace (the shared agent belongs to workspace ws-1 only)", async () => {
    signIn("other-admin")
    mocks.agent.findFirst.mockResolvedValue(sharedAgent)
    // isWorkspaceAdminUser looks up the OWNING workspace (ws-1) for this user: not an admin there.
    arrangeWorkspace({ adminUserIds: [] })
    await expect(updateCloudAgent("a-shared", { name: "Hijack" })).rejects.toThrow("Agent not found")
  })

  it("does not treat an EXTERNAL agent as a cloud agent", async () => {
    mocks.agent.findFirst.mockResolvedValue({ ...personalAgent, kind: "EXTERNAL" })
    await expect(updateCloudAgent("a-personal", { instructions: "x" })).rejects.toThrow("Agent not found")
  })

  it("refuses an invoke policy on a personal agent", async () => {
    mocks.agent.findFirst.mockResolvedValue(personalAgent)
    await expect(updateCloudAgent("a-personal", { invokePolicy: "WORKSPACE_MEMBERS" })).rejects.toThrow("Only shared agents")
    expect(mocks.agent.update).not.toHaveBeenCalled()
  })
})

describe("setWorkspaceDefaultAgentAction", () => {
  beforeEach(() => {
    mocks.admin.mockResolvedValue({ prisma: mocks, workspaceId: WS, organizationId: "org" })
    mocks.agent.findFirst.mockResolvedValue(sharedAgent)
  })

  it("sets the default for an administrator, recording who set it", async () => {
    signIn("admin")
    await setWorkspaceDefaultAgentAction("acme", "home", "a-shared")
    expect(mocks.defaults.setWs).toHaveBeenCalledWith(mocks, { workspaceId: WS, agentId: "a-shared", setByUserId: "admin" })
  })

  it("is refused for a non-admin without touching the default", async () => {
    mocks.admin.mockRejectedValue(new FakePermissionError("Forbidden: workspace admin required"))
    await expect(setWorkspaceDefaultAgentAction("acme", "home", "a-shared")).rejects.toThrow("workspace admin required")
    expect(mocks.defaults.setWs).not.toHaveBeenCalled()
    await expect(setWorkspaceDefaultAgentAction("acme", "home", null)).rejects.toThrow("workspace admin required")
    expect(mocks.defaults.clearWs).not.toHaveBeenCalled()
  })

  it.each([
    ["a personal agent", () => mocks.agent.findFirst.mockResolvedValue(personalAgent)],
    ["a shared agent of another workspace", () => mocks.agent.findFirst.mockResolvedValue({ ...sharedAgent, ownerWorkspaceId: "ws-other" })],
    ["a suspended agent", () => mocks.agent.findFirst.mockResolvedValue({ ...sharedAgent, status: "SUSPENDED" })],
    ["an EXTERNAL agent", () => mocks.agent.findFirst.mockResolvedValue({ ...sharedAgent, kind: "EXTERNAL" })],
    ["a missing agent", () => mocks.agent.findFirst.mockResolvedValue(null)],
  ])("refuses %s", async (_label, arrange) => {
    arrange()
    await expect(setWorkspaceDefaultAgentAction("acme", "home", "a-shared")).rejects.toThrow("active shared cloud agent")
    expect(mocks.defaults.setWs).not.toHaveBeenCalled()
  })

  it("refuses an agent that is not enabled in the workspace", async () => {
    mocks.liveGrants.mockResolvedValue([])
    await expect(setWorkspaceDefaultAgentAction("acme", "home", "a-shared")).rejects.toThrow("Enable this agent")
    expect(mocks.defaults.setWs).not.toHaveBeenCalled()
  })

  it("clears the default (also while the rollout flag is off)", async () => {
    mocks.enabled.mockReturnValue(false)
    await setWorkspaceDefaultAgentAction("acme", "home", null)
    expect(mocks.defaults.clearWs).toHaveBeenCalledWith(mocks, WS)
  })
})

describe("setMyDefaultAgentAction", () => {
  it("sets a personal default after the same checks a run goes through, for the caller and the slug-resolved workspace only", async () => {
    mocks.resolveRunAgent.mockResolvedValue(sharedAgent)
    await setMyDefaultAgentAction("acme", "home", "a-shared")
    expect(mocks.resolveRunAgent).toHaveBeenCalledWith(mocks, { userId: "member", workspaceId: WS, requestedAgentId: "a-shared" })
    expect(mocks.defaults.setUser).toHaveBeenCalledWith(mocks, { userId: "member", workspaceId: WS, agentId: "a-shared" })
  })

  it("surfaces a refusal (not invokable, not found) and writes nothing", async () => {
    mocks.resolveRunAgent.mockRejectedValue(new AgentSelectionError("You are not allowed to run this agent.", 403, "AGENT_NOT_INVOKABLE"))
    await expect(setMyDefaultAgentAction("acme", "home", "a-personal")).rejects.toThrow("not allowed to run this agent")
    expect(mocks.defaults.setUser).not.toHaveBeenCalled()
  })

  it("refuses a non-member of the workspace", async () => {
    arrangeWorkspace({ member: false })
    await expect(setMyDefaultAgentAction("acme", "home", "a-shared")).rejects.toThrow("Workspace not found")
    expect(mocks.defaults.setUser).not.toHaveBeenCalled()
  })

  it("never accepts the built-in selector as an agent id", async () => {
    mocks.resolveRunAgent.mockResolvedValue(null)
    await expect(setMyDefaultAgentAction("acme", "home", "builtin")).rejects.toThrow("Agent not found")
    expect(mocks.defaults.setUser).not.toHaveBeenCalled()
  })

  it("clears the personal default", async () => {
    await setMyDefaultAgentAction("acme", "home", null)
    expect(mocks.defaults.clearUser).toHaveBeenCalledWith(mocks, { userId: "member", workspaceId: WS })
  })
})
