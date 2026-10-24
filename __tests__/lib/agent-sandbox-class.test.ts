import { describe, it, expect, vi } from "vitest"

vi.mock("@/lib/agent-runtime-config", () => ({ getGoldenSnapshotId: vi.fn() }))
vi.mock("@/lib/agent-runtime-snapshots", () => ({ getRuntimeSnapshot: vi.fn() }))

import { parseSandboxClass, readAgentSandboxClass, readWorkspaceDeveloperSandboxEnabled, resolveRunSnapshot } from "@/lib/agent-sandbox-class"

const prismaWith = (agentClass: unknown, workspaceEnabled: unknown) =>
  ({
    agent: { findUnique: vi.fn().mockResolvedValue(agentClass === undefined ? null : { sandboxClass: agentClass }) },
    workspace: { findUnique: vi.fn().mockResolvedValue({ agentDeveloperSandboxEnabled: workspaceEnabled }) },
  }) as never
const missingColumn = () => Object.assign(new Error("column does not exist"), { code: "P2022" })
const deps = (standard: string | null, developer: string | null) => ({ getStandardSnapshotId: async () => standard, getDeveloperSnapshotId: async () => developer })

describe("sandbox class reads", () => {
  it("treats anything but DEVELOPER as STANDARD", () => {
    expect(parseSandboxClass("DEVELOPER")).toBe("DEVELOPER")
    for (const v of [null, undefined, "STANDARD", "developer", 3]) expect(parseSandboxClass(v)).toBe("STANDARD")
  })

  it("reads STANDARD / off when migration 110 is not applied", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const prisma = { agent: { findUnique: vi.fn().mockRejectedValue(missingColumn()) }, workspace: { findUnique: vi.fn().mockRejectedValue(missingColumn()) } } as never
    expect(await readAgentSandboxClass(prisma, "a")).toBe("STANDARD")
    expect(await readWorkspaceDeveloperSandboxEnabled(prisma, "w")).toBe(false)
  })

  it("reads the workspace flag as on only when it is exactly true", async () => {
    expect(await readWorkspaceDeveloperSandboxEnabled(prismaWith("STANDARD", true), "w")).toBe(true)
    expect(await readWorkspaceDeveloperSandboxEnabled(prismaWith("STANDARD", null), "w")).toBe(false)
  })
})

describe("resolveRunSnapshot", () => {
  it("gives the built-in agent and STANDARD agents the golden snapshot, without reading the workspace flag", async () => {
    const prisma = prismaWith("STANDARD", true)
    expect(await resolveRunSnapshot(prisma, { workspaceId: "w", agentId: null }, deps("snap_std", "snap_dev"))).toEqual({ ok: true, snapshotId: "snap_std", sandboxClass: "STANDARD" })
    expect(await resolveRunSnapshot(prisma, { workspaceId: "w", agentId: "a" }, deps("snap_std", "snap_dev"))).toMatchObject({ ok: true, snapshotId: "snap_std" })
    expect((prisma as { workspace: { findUnique: ReturnType<typeof vi.fn> } }).workspace.findUnique).not.toHaveBeenCalled()
  })

  it("boots a DEVELOPER agent from the developer snapshot when the workspace allows it", async () => {
    expect(await resolveRunSnapshot(prismaWith("DEVELOPER", true), { workspaceId: "w", agentId: "a" }, deps("snap_std", "snap_dev"))).toEqual({ ok: true, snapshotId: "snap_dev", sandboxClass: "DEVELOPER" })
  })

  it("refuses a DEVELOPER agent in a workspace that has not enabled it, rather than downgrading it", async () => {
    const result = await resolveRunSnapshot(prismaWith("DEVELOPER", false), { workspaceId: "w", agentId: "a" }, deps("snap_std", "snap_dev"))
    expect(result).toMatchObject({ ok: false, code: "DEVELOPER_SANDBOX_DISABLED" })
  })

  it("refuses a DEVELOPER agent when the developer snapshot has not been built", async () => {
    const result = await resolveRunSnapshot(prismaWith("DEVELOPER", true), { workspaceId: "w", agentId: "a" }, deps("snap_std", null))
    expect(result).toMatchObject({ ok: false, code: "DEVELOPER_SNAPSHOT_MISSING", message: expect.stringContaining("class=developer") })
  })

  it("reports a missing golden snapshot for a STANDARD run", async () => {
    expect(await resolveRunSnapshot(prismaWith("STANDARD", false), { workspaceId: "w", agentId: "a" }, deps(null, "snap_dev"))).toMatchObject({ ok: false, code: "STANDARD_SNAPSHOT_MISSING" })
  })
})
