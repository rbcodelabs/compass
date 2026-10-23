import { beforeEach, describe, expect, it, vi } from "vitest"

const db = vi.hoisted(() => ({
  workspaceModule: { findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
  workspace: { findUnique: vi.fn(), update: vi.fn() },
}))
vi.unmock("@/lib/modules/server")
vi.mock("@/lib/db", () => ({ default: () => db }))

import { ModuleDisabledError, describeModules, isModuleEnabled, requireModule, setWorkspaceModule } from "@/lib/modules/server"

const rows = (entries: Record<string, boolean>) => Object.entries(entries).map(([moduleKey, enabled], i) => ({ id: `row-${i}`, moduleKey, enabled }))

describe("module server helper", () => {
  beforeEach(() => vi.clearAllMocks())

  it("reads the stored row", async () => {
    db.workspaceModule.findMany.mockResolvedValue(rows({ research_capture: true }))
    expect(await isModuleEnabled("w1", "research_capture")).toBe(true)
    expect(await isModuleEnabled("w1", "following")).toBe(false)
  })

  it("requireModule throws the actionable error", async () => {
    db.workspaceModule.findMany.mockResolvedValue([])
    await expect(requireModule("w2", "research_capture")).rejects.toThrow(ModuleDisabledError)
    await expect(requireModule("w2", "research_capture")).rejects.toThrow("Research capture is not enabled for this workspace. A workspace admin can enable it in Settings > Modules.")
  })

  it("fails closed with the table missing, except launch_workflow which falls back to the legacy column", async () => {
    db.workspaceModule.findMany.mockRejectedValue({ code: "P2021" })
    db.workspace.findUnique.mockResolvedValue({ launchWorkflowEnabled: true })
    expect(await isModuleEnabled("w3", "research_capture")).toBe(false)
    expect(await isModuleEnabled("w3", "launch_workflow")).toBe(true)
  })

  it("propagates any other database error instead of enabling", async () => {
    db.workspaceModule.findMany.mockRejectedValue(new Error("connection reset"))
    await expect(isModuleEnabled("w4", "research_capture")).rejects.toThrow("connection reset")
  })

  it("describes why a selected module is off", async () => {
    db.workspaceModule.findMany.mockResolvedValue(rows({ research_voice_browser: true }))
    const view = (await describeModules("w5")).find((m) => m.key === "research_voice_browser")!
    expect(view).toMatchObject({ enabled: false, selected: true, explicit: true, blockedBy: ["research_capture"] })
  })

  describe("setWorkspaceModule", () => {
    it("creates a row for a first-time enable and records the admin", async () => {
      db.workspaceModule.findMany.mockResolvedValue([])
      const changes = await setWorkspaceModule({ workspaceId: "w6", key: "research_capture", enabled: true, userId: "u1" })
      expect(changes).toEqual([{ key: "research_capture", enabled: true }])
      expect(db.workspaceModule.create).toHaveBeenCalledWith({ data: expect.objectContaining({ workspaceId: "w6", moduleKey: "research_capture", enabled: true, updatedByUserId: "u1" }) })
    })

    it("refuses to enable without the requirement and writes nothing", async () => {
      db.workspaceModule.findMany.mockResolvedValue([])
      await expect(setWorkspaceModule({ workspaceId: "w7", key: "research_voice_browser", enabled: true, userId: "u1" })).rejects.toThrow(/requires Research capture/)
      expect(db.workspaceModule.create).not.toHaveBeenCalled()
    })

    it("disabling cascades to dependents by updating their rows", async () => {
      db.workspaceModule.findMany.mockResolvedValue(rows({ research_capture: true, research_voice_browser: true }))
      await setWorkspaceModule({ workspaceId: "w8", key: "research_capture", enabled: false, userId: "u1" })
      expect(db.workspaceModule.update).toHaveBeenCalledTimes(2)
    })

    it("mirrors the launch workflow into the legacy column", async () => {
      db.workspaceModule.findMany.mockResolvedValue([])
      await setWorkspaceModule({ workspaceId: "w9", key: "launch_workflow", enabled: true, userId: "u1" })
      expect(db.workspace.update).toHaveBeenCalledWith({ where: { id: "w9" }, data: { launchWorkflowEnabled: true }, select: { id: true } })
    })
  })
})
