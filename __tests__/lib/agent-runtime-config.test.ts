import { describe, it, expect, vi, beforeEach } from "vitest"

const mockAgentRuntimeConfig = { findUnique: vi.fn(), upsert: vi.fn() }
vi.mock("@/lib/db", () => ({ default: () => ({ agentRuntimeConfig: mockAgentRuntimeConfig }) }))

import {
  getAgentRuntimeConfig,
  getGoldenSnapshotId,
  isSnapshotStale,
  setGoldenSnapshot,
} from "@/lib/agent-runtime-config"

beforeEach(() => vi.clearAllMocks())

describe("getAgentRuntimeConfig / getGoldenSnapshotId", () => {
  it("returns null when the singleton has never been initialized", async () => {
    mockAgentRuntimeConfig.findUnique.mockResolvedValue(null)
    expect(await getAgentRuntimeConfig()).toBeNull()
    expect(await getGoldenSnapshotId()).toBeNull()
    expect(mockAgentRuntimeConfig.findUnique).toHaveBeenCalledWith({
      where: { scope: "global" },
      select: { goldenSnapshotId: true, depsFingerprint: true, snapshotBuiltAt: true },
    })
  })

  it("returns the stored snapshot id", async () => {
    mockAgentRuntimeConfig.findUnique.mockResolvedValue({
      goldenSnapshotId: "snap_abc",
      depsFingerprint: "fp1",
      snapshotBuiltAt: new Date(),
    })
    expect(await getGoldenSnapshotId()).toBe("snap_abc")
  })
})

describe("isSnapshotStale", () => {
  it("is stale when nothing has been built", async () => {
    mockAgentRuntimeConfig.findUnique.mockResolvedValue(null)
    expect(await isSnapshotStale("fp1")).toBe(true)
  })

  it("is stale when the stored fingerprint differs", async () => {
    mockAgentRuntimeConfig.findUnique.mockResolvedValue({
      goldenSnapshotId: "snap_abc",
      depsFingerprint: "OLD",
      snapshotBuiltAt: new Date(),
    })
    expect(await isSnapshotStale("NEW")).toBe(true)
  })

  it("is fresh when the fingerprint matches and a snapshot exists", async () => {
    mockAgentRuntimeConfig.findUnique.mockResolvedValue({
      goldenSnapshotId: "snap_abc",
      depsFingerprint: "fp1",
      snapshotBuiltAt: new Date(),
    })
    expect(await isSnapshotStale("fp1")).toBe(false)
  })
})

describe("setGoldenSnapshot", () => {
  it("upserts the singleton keyed by scope and sets updatedAt explicitly", async () => {
    mockAgentRuntimeConfig.upsert.mockResolvedValue({})
    const builtAt = new Date("2026-08-07T00:00:00Z")
    await setGoldenSnapshot({ goldenSnapshotId: "snap_x", depsFingerprint: "fp2", snapshotBuiltAt: builtAt })
    const call = mockAgentRuntimeConfig.upsert.mock.calls[0][0]
    expect(call.where).toEqual({ scope: "global" })
    expect(call.create).toMatchObject({ scope: "global", goldenSnapshotId: "snap_x", depsFingerprint: "fp2" })
    expect(call.create.updatedAt).toBeInstanceOf(Date)
    expect(call.update).toMatchObject({ goldenSnapshotId: "snap_x", depsFingerprint: "fp2" })
    expect(call.update.updatedAt).toBeInstanceOf(Date)
  })
})
