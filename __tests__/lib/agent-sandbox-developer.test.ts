import { describe, it, expect, vi, beforeEach } from "vitest"

const m = vi.hoisted(() => ({
  getConfig: vi.fn(), getRow: vi.fn(), setRow: vi.fn(), build: vi.fn(), del: vi.fn(),
}))
vi.mock("@/lib/agent-runtime-config", () => ({ getAgentRuntimeConfig: m.getConfig, setGoldenSnapshot: vi.fn() }))
vi.mock("@/lib/agent-runtime-snapshots", () => ({ getRuntimeSnapshot: m.getRow, setRuntimeSnapshot: m.setRow }))
vi.mock("@vercel/sandbox", () => ({ Sandbox: { create: vi.fn() }, Snapshot: { get: vi.fn() } }))
vi.mock("@/lib/agent-sandbox", async (orig) => ({ ...(await orig<typeof import("@/lib/agent-sandbox")>()), deleteGoldenSnapshot: m.del }))
vi.mock("@/lib/agent-sandbox-developer", async (orig) => ({ ...(await orig<typeof import("@/lib/agent-sandbox-developer")>()), buildDeveloperSnapshot: m.build }))

import {
  bakePostgresScript, computeDeveloperFingerprint, developerSmokeScript, DEVELOPER_SYSTEM_PACKAGES, EXTRA_NODE, extraNodeInstallScript, PNPM_VERSION,
} from "@/lib/agent-sandbox-developer"
import { getDeveloperSnapshotStatus, rebuildDeveloperSnapshot } from "@/lib/agent-snapshot-admin"

const FP = computeDeveloperFingerprint()

beforeEach(() => {
  vi.clearAllMocks()
  m.getConfig.mockResolvedValue({ goldenSnapshotId: "snap_base", depsFingerprint: "x", snapshotBuiltAt: new Date() })
  m.getRow.mockResolvedValue(null)
  m.build.mockResolvedValue({ snapshotId: "snap_dev_new", depsFingerprint: FP, baseSnapshotId: "snap_base", sizeBytes: 1, postgresVersion: "16.15", timings: {} })
  m.del.mockResolvedValue(undefined)
})

describe("developer recipe", () => {
  it("is stable and pins checksums, so a silent change shows up as a diff", () => {
    expect(computeDeveloperFingerprint()).toBe(FP)
    expect(FP).toMatch(/^[0-9a-f]{64}$/)
    expect(EXTRA_NODE.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(extraNodeInstallScript()).toContain(`echo "${EXTRA_NODE.sha256}  node-v${EXTRA_NODE.version}-linux-x64.tar.xz" | sha256sum -c -`)
  })

  it("covers the package list and pnpm version", () => {
    const original = [...DEVELOPER_SYSTEM_PACKAGES]
    ;(DEVELOPER_SYSTEM_PACKAGES as string[]).push("extra-pkg")
    try {
      expect(computeDeveloperFingerprint()).not.toBe(FP)
    } finally {
      ;(DEVELOPER_SYSTEM_PACKAGES as string[]).length = 0
      ;(DEVELOPER_SYSTEM_PACKAGES as string[]).push(...original)
    }
    expect(PNPM_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it("bakes the cluster as the unprivileged user and smoke-tests a copy of it", () => {
    expect(bakePostgresScript()).toContain("initdb")
    expect(bakePostgresScript()).not.toContain("sudo")
    expect(developerSmokeScript()).toContain("select version()")
    expect(developerSmokeScript()).toContain("pg_ctl")
  })
})

describe("getDeveloperSnapshotStatus", () => {
  const row = (over = {}) => ({ snapshotId: "snap_dev", depsFingerprint: FP, baseSnapshotId: "snap_base", snapshotBuiltAt: new Date(), ...over })

  it("is stale when never built", async () => {
    expect((await getDeveloperSnapshotStatus()).stale).toBe(true)
  })

  it("is fresh when recipe and base both match", async () => {
    m.getRow.mockResolvedValue(row())
    expect((await getDeveloperSnapshotStatus()).stale).toBe(false)
  })

  it("is stale when STANDARD was rebuilt (new base id) or the recipe changed", async () => {
    m.getRow.mockResolvedValue(row({ baseSnapshotId: "snap_old_base" }))
    expect((await getDeveloperSnapshotStatus()).stale).toBe(true)
    m.getRow.mockResolvedValue(row({ depsFingerprint: "old" }))
    expect((await getDeveloperSnapshotStatus()).stale).toBe(true)
  })
})

describe("rebuildDeveloperSnapshot", () => {
  it("refuses, without building, when STANDARD has never been built", async () => {
    m.getConfig.mockResolvedValue(null)
    const result = await rebuildDeveloperSnapshot()
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("STANDARD") })
    expect(m.build).not.toHaveBeenCalled()
  })

  it("builds on the current golden snapshot, persists it, then deletes the previous developer snapshot", async () => {
    m.getRow.mockResolvedValue({ snapshotId: "snap_dev_old" })
    const order: string[] = []
    m.setRow.mockImplementation(async () => void order.push("persist"))
    m.del.mockImplementation(async () => void order.push("delete"))
    const result = await rebuildDeveloperSnapshot()
    expect(m.build).toHaveBeenCalledWith(expect.objectContaining({ baseSnapshotId: "snap_base" }))
    expect(m.setRow).toHaveBeenCalledWith("DEVELOPER", expect.objectContaining({ snapshotId: "snap_dev_new", baseSnapshotId: "snap_base" }))
    expect(order).toEqual(["persist", "delete"])
    expect(m.del).toHaveBeenCalledWith("snap_dev_old")
    expect(result).toMatchObject({ ok: true, deletedPreviousSnapshot: true })
  })

  it("keeps the previous snapshot when the build fails, and treats a failed delete as a warning", async () => {
    m.getRow.mockResolvedValue({ snapshotId: "snap_dev_old" })
    m.build.mockRejectedValueOnce(new Error("dnf failed"))
    expect(await rebuildDeveloperSnapshot()).toMatchObject({ ok: false, error: "dnf failed" })
    expect(m.setRow).not.toHaveBeenCalled()
    expect(m.del).not.toHaveBeenCalled()

    m.del.mockRejectedValueOnce(new Error("quota"))
    expect(await rebuildDeveloperSnapshot()).toMatchObject({ ok: true, deletedPreviousSnapshot: false, previousSnapshotDeleteError: "quota" })
  })
})
