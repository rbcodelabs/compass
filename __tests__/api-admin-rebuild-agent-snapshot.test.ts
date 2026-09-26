/**
 * Unit tests for app/api/admin/rebuild-agent-snapshot/route.ts.
 *
 * Covers the snapshot-leak fix: every rebuild must delete the *previous*
 * golden snapshot only after the new one is confirmed persisted, must never
 * fail the whole request if that cleanup delete fails, and must skip cleanup
 * when there's nothing to delete (first-ever build) or the previous id is
 * somehow the same as the new one.
 *
 * Mocks lib/agent-sandbox and lib/agent-runtime-config; never hits real
 * Vercel Sandbox infra or the database.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { NextRequest } from "next/server"

const {
  mockBuildGoldenSnapshot,
  mockDeleteGoldenSnapshot,
  mockGetAgentRuntimeConfig,
  mockSetGoldenSnapshot,
} = vi.hoisted(() => ({
  mockBuildGoldenSnapshot: vi.fn(),
  mockDeleteGoldenSnapshot: vi.fn(),
  mockGetAgentRuntimeConfig: vi.fn(),
  mockSetGoldenSnapshot: vi.fn(),
}))

vi.mock("@/lib/agent-sandbox", () => ({
  buildGoldenSnapshot: mockBuildGoldenSnapshot,
  deleteGoldenSnapshot: mockDeleteGoldenSnapshot,
  computeDepsFingerprint: () => "fp-current",
}))

vi.mock("@/lib/agent-runtime-config", () => ({
  getAgentRuntimeConfig: mockGetAgentRuntimeConfig,
  setGoldenSnapshot: mockSetGoldenSnapshot,
}))

import { POST } from "@/app/api/admin/rebuild-agent-snapshot/route"

const ORIGINAL_ENV = { ...process.env }

function request(secret?: string) {
  return new NextRequest("http://localhost/api/admin/rebuild-agent-snapshot", {
    method: "POST",
    headers: secret ? { "x-migration-secret": secret } : {},
  })
}

const NEW_RESULT = {
  snapshotId: "snap_new",
  depsFingerprint: "fp-current",
  sizeBytes: 12345,
  timings: { createMs: 1, installMs: 2, snapshotMs: 3, totalMs: 6 },
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.MIGRATION_SECRET = "test-migration-secret"
  mockBuildGoldenSnapshot.mockResolvedValue(NEW_RESULT)
  mockSetGoldenSnapshot.mockResolvedValue(undefined)
  mockDeleteGoldenSnapshot.mockResolvedValue(undefined)
})

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
})

describe("POST /api/admin/rebuild-agent-snapshot", () => {
  it("rejects a request without the correct x-migration-secret header", async () => {
    const res = await POST(request("wrong-secret"))
    expect(res.status).toBe(401)
    expect(mockBuildGoldenSnapshot).not.toHaveBeenCalled()
  })

  it("rejects (401) when MIGRATION_SECRET is not configured on the server", async () => {
    delete process.env.MIGRATION_SECRET
    const res = await POST(request("anything"))
    expect(res.status).toBe(401)
    expect(mockBuildGoldenSnapshot).not.toHaveBeenCalled()
  })

  it("first-ever build: does not attempt to delete anything when there is no previous snapshot", async () => {
    mockGetAgentRuntimeConfig.mockResolvedValue(null)

    const res = await POST(request("test-migration-secret"))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.previousSnapshotId).toBeNull()
    expect(body.deletedPreviousSnapshot).toBe(false)
    expect(mockDeleteGoldenSnapshot).not.toHaveBeenCalled()
  })

  it("normal rebuild: persists the new snapshot BEFORE deleting the previous one, then deletes it", async () => {
    mockGetAgentRuntimeConfig.mockResolvedValue({
      goldenSnapshotId: "snap_old",
      depsFingerprint: "fp-old",
      snapshotBuiltAt: new Date(),
    })

    const callOrder: string[] = []
    mockSetGoldenSnapshot.mockImplementation(async () => {
      callOrder.push("setGoldenSnapshot")
    })
    mockDeleteGoldenSnapshot.mockImplementation(async () => {
      callOrder.push("deleteGoldenSnapshot")
    })

    const res = await POST(request("test-migration-secret"))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.previousSnapshotId).toBe("snap_old")
    expect(body.deletedPreviousSnapshot).toBe(true)

    // The new snapshot must be persisted as golden strictly before the old
    // one is deleted — never the other way around.
    expect(callOrder).toEqual(["setGoldenSnapshot", "deleteGoldenSnapshot"])
    expect(mockSetGoldenSnapshot).toHaveBeenCalledWith({
      goldenSnapshotId: "snap_new",
      depsFingerprint: "fp-current",
      snapshotBuiltAt: expect.any(Date),
    })
    expect(mockDeleteGoldenSnapshot).toHaveBeenCalledWith("snap_old")
  })

  it("skips cleanup when the previous snapshot id is somehow identical to the new one", async () => {
    mockGetAgentRuntimeConfig.mockResolvedValue({
      goldenSnapshotId: "snap_new",
      depsFingerprint: "fp-current",
      snapshotBuiltAt: new Date(),
    })

    const res = await POST(request("test-migration-secret"))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.deletedPreviousSnapshot).toBe(false)
    expect(mockDeleteGoldenSnapshot).not.toHaveBeenCalled()
  })

  it("a failed cleanup delete is a non-fatal warning, not a 500 — the rebuild already succeeded", async () => {
    mockGetAgentRuntimeConfig.mockResolvedValue({
      goldenSnapshotId: "snap_old",
      depsFingerprint: "fp-old",
      snapshotBuiltAt: new Date(),
    })
    mockDeleteGoldenSnapshot.mockRejectedValue(new Error("snapshot already deleted"))

    const res = await POST(request("test-migration-secret"))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.deletedPreviousSnapshot).toBe(false)
    expect(body.previousSnapshotDeleteError).toBe("snapshot already deleted")
    expect(body.log.some((line: string) => line.includes("WARNING") && line.includes("snap_old"))).toBe(true)
    // The new snapshot is still golden even though cleanup of the old one failed.
    expect(mockSetGoldenSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ goldenSnapshotId: "snap_new" })
    )
  })

  it("returns 500 and never persists or deletes anything when the build itself fails", async () => {
    mockGetAgentRuntimeConfig.mockResolvedValue({
      goldenSnapshotId: "snap_old",
      depsFingerprint: "fp-old",
      snapshotBuiltAt: new Date(),
    })
    mockBuildGoldenSnapshot.mockRejectedValue(new Error("npm install failed with exit code 1"))

    const res = await POST(request("test-migration-secret"))
    const body = await res.json()

    expect(res.status).toBe(500)
    expect(body.ok).toBe(false)
    expect(mockSetGoldenSnapshot).not.toHaveBeenCalled()
    expect(mockDeleteGoldenSnapshot).not.toHaveBeenCalled()
  })

  it("returns 500 and never deletes the previous snapshot when persisting the new one fails", async () => {
    mockGetAgentRuntimeConfig.mockResolvedValue({
      goldenSnapshotId: "snap_old",
      depsFingerprint: "fp-old",
      snapshotBuiltAt: new Date(),
    })
    mockSetGoldenSnapshot.mockRejectedValue(new Error("db unavailable"))

    const res = await POST(request("test-migration-secret"))
    const body = await res.json()

    expect(res.status).toBe(500)
    expect(body.ok).toBe(false)
    // Must NOT have deleted the old snapshot — we don't yet have a confirmed
    // new golden snapshot to fall back to.
    expect(mockDeleteGoldenSnapshot).not.toHaveBeenCalled()
  })
})
