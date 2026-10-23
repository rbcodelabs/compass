import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  resolveWorkspaceAdmin: vi.fn(),
  setWorkspaceModule: vi.fn(),
  describeModules: vi.fn(),
  actor: vi.fn(),
}))

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))
vi.mock("@/auth", () => ({ auth: async () => ({ user: { id: "user-1" } }) }))
vi.mock("@/lib/permissions", async () => {
  class PermissionError extends Error {}
  return { PermissionError, isPermissionError: (e: unknown) => e instanceof PermissionError, resolveWorkspaceAdmin: mocks.resolveWorkspaceAdmin }
})
vi.mock("@/lib/modules/server", () => ({ setWorkspaceModule: mocks.setWorkspaceModule, describeModules: mocks.describeModules }))
vi.mock("@/lib/mcp-authz", () => ({ getMcpActor: mocks.actor }))

import { PermissionError } from "@/lib/permissions"
import { ModuleToggleError } from "@/lib/modules/registry"
import { setWorkspaceModuleEnabled } from "@/app/[orgSlug]/[workspaceSlug]/settings/modules/actions"
import { listWorkspaceModulesTool, updateWorkspaceModuleTool } from "@/lib/module-tool-handlers"

describe("setWorkspaceModuleEnabled (Settings > Modules)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.describeModules.mockResolvedValue([])
  })

  it("is gated on a workspace admin and writes nothing for anyone else", async () => {
    mocks.resolveWorkspaceAdmin.mockRejectedValue(new PermissionError("Forbidden: workspace admin required"))
    const result = await setWorkspaceModuleEnabled("org", "ws", "research_capture", true)
    expect(result).toEqual({ ok: false, error: "Forbidden: workspace admin required" })
    expect(mocks.setWorkspaceModule).not.toHaveBeenCalled()
  })

  it("toggles for an admin, recording who", async () => {
    mocks.resolveWorkspaceAdmin.mockResolvedValue({ workspaceId: "w1" })
    mocks.setWorkspaceModule.mockResolvedValue([{ key: "research_capture", enabled: true }])
    const result = await setWorkspaceModuleEnabled("org", "ws", "research_capture", true)
    expect(result.ok).toBe(true)
    expect(mocks.setWorkspaceModule).toHaveBeenCalledWith({ workspaceId: "w1", key: "research_capture", enabled: true, userId: "user-1" })
  })

  it("returns an unmet requirement as a value", async () => {
    mocks.resolveWorkspaceAdmin.mockResolvedValue({ workspaceId: "w1" })
    mocks.setWorkspaceModule.mockRejectedValue(new ModuleToggleError("Research voice: browser requires Research capture to be enabled first.", "REQUIREMENT_DISABLED"))
    expect(await setWorkspaceModuleEnabled("org", "ws", "research_voice_browser", true)).toEqual({ ok: false, error: expect.stringContaining("requires Research capture") })
  })

  it("rejects a non-boolean without resolving anything", async () => {
    expect((await setWorkspaceModuleEnabled("org", "ws", "research_capture", "yes" as never)).ok).toBe(false)
    expect(mocks.resolveWorkspaceAdmin).not.toHaveBeenCalled()
  })
})

describe("MCP workspace module tools", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.describeModules.mockResolvedValue([
      { key: "research_capture", label: "Research capture", enabled: false, selected: false, explicit: false, blockedBy: [] },
    ])
  })

  it("list_workspace_modules reports state and points at Settings > Modules", async () => {
    const result = await listWorkspaceModulesTool({ workspaceId: "w1" })
    expect(result.structuredContent.ok).toBe(true)
    expect(result.content[0].text).toContain("OFF research_capture")
    expect(result.content[0].text).toContain("Settings > Modules")
    expect((result.structuredContent.data as { count: number }).count).toBe(1)
  })

  it("update_workspace_module refuses agent identities", async () => {
    mocks.actor.mockReturnValue({ purpose: "AGENT", agentId: "a1", userId: "user-1" })
    const result = await updateWorkspaceModuleTool({ workspaceId: "w1", moduleKey: "research_capture", enabled: true })
    expect(result.structuredContent.ok).toBe(false)
    expect(mocks.setWorkspaceModule).not.toHaveBeenCalled()
  })

  it("update_workspace_module changes a module for a human and reports the workspace ID", async () => {
    mocks.actor.mockReturnValue({ purpose: "USER", userId: "user-1" })
    mocks.setWorkspaceModule.mockResolvedValue([{ key: "research_capture", enabled: true }])
    const result = await updateWorkspaceModuleTool({ workspaceId: "w1", moduleKey: "research_capture", enabled: true })
    expect(result.structuredContent.ok).toBe(true)
    expect(result.content[0].text).toContain("ID: w1")
    expect(mocks.setWorkspaceModule).toHaveBeenCalledWith({ workspaceId: "w1", key: "research_capture", enabled: true, userId: "user-1" })
  })

  it("update_workspace_module returns an unmet requirement as a failure", async () => {
    mocks.actor.mockReturnValue({ purpose: "USER", userId: "user-1" })
    mocks.setWorkspaceModule.mockRejectedValue(new ModuleToggleError("needs capture", "REQUIREMENT_DISABLED"))
    const result = await updateWorkspaceModuleTool({ workspaceId: "w1", moduleKey: "research_voice_browser", enabled: true })
    expect(result.structuredContent).toMatchObject({ ok: false, message: "needs capture" })
  })
})
