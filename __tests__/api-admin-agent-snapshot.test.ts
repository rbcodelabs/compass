/**
 * Session-authed platform-admin twin of /api/admin/rebuild-agent-snapshot.
 * Mocks auth and the sandbox/config libs; never touches real infra.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

const { mockAuth, mockBuild, mockDelete, mockGetConfig, mockSet } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockBuild: vi.fn(),
  mockDelete: vi.fn(),
  mockGetConfig: vi.fn(),
  mockSet: vi.fn(),
}))

vi.mock("@/auth", () => ({ auth: mockAuth }))
vi.mock("@/lib/agent-sandbox", () => ({
  buildGoldenSnapshot: mockBuild,
  deleteGoldenSnapshot: mockDelete,
  computeDepsFingerprint: () => "fp-current",
}))
vi.mock("@/lib/agent-runtime-config", () => ({
  getAgentRuntimeConfig: mockGetConfig,
  setGoldenSnapshot: mockSet,
}))

import { GET, POST } from "@/app/api/admin/agent-snapshot/route"

const ORIGINAL_ENV = { ...process.env }
const RESULT = {
  snapshotId: "snap_new",
  depsFingerprint: "fp-current",
  sizeBytes: 1,
  timings: { createMs: 1, installMs: 2, snapshotMs: 3, totalMs: 6 },
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.PLATFORM_ADMIN_EMAILS = "admin@example.com"
  mockAuth.mockResolvedValue({ user: { id: "u1", email: "Admin@Example.com" } })
  mockGetConfig.mockResolvedValue({
    goldenSnapshotId: "snap_old",
    depsFingerprint: "fp-old",
    snapshotBuiltAt: new Date("2026-01-01T00:00:00Z"),
  })
  mockBuild.mockResolvedValue(RESULT)
  mockSet.mockResolvedValue(undefined)
  mockDelete.mockResolvedValue(undefined)
})

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
})

describe("/api/admin/agent-snapshot", () => {
  for (const [name, handler] of [["GET", GET], ["POST", POST]] as const) {
    it(`${name}: 401 without a session, and never builds`, async () => {
      mockAuth.mockResolvedValue(null)
      expect((await handler()).status).toBe(401)
      expect(mockBuild).not.toHaveBeenCalled()
    })

    it(`${name}: 403 for a signed-in non-admin`, async () => {
      mockAuth.mockResolvedValue({ user: { id: "u2", email: "other@example.com" } })
      expect((await handler()).status).toBe(403)
      expect(mockBuild).not.toHaveBeenCalled()
    })

    it(`${name}: 403 for everyone when PLATFORM_ADMIN_EMAILS is unset`, async () => {
      delete process.env.PLATFORM_ADMIN_EMAILS
      expect((await handler()).status).toBe(403)
      expect(mockBuild).not.toHaveBeenCalled()
    })
  }

  it("GET returns status for an admin", async () => {
    const res = await GET()
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      goldenSnapshotId: "snap_old",
      depsFingerprint: "fp-old",
      currentDepsFingerprint: "fp-current",
      stale: true,
    })
  })

  it("POST rebuilds, persists, then deletes the previous snapshot", async () => {
    const order: string[] = []
    mockSet.mockImplementation(async () => void order.push("set"))
    mockDelete.mockImplementation(async () => void order.push("delete"))
    const res = await POST()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({
      ok: true,
      snapshotId: "snap_new",
      previousSnapshotId: "snap_old",
      deletedPreviousSnapshot: true,
    })
    expect(order).toEqual(["set", "delete"])
  })

  it("POST reports a delete failure as a warning, not an error", async () => {
    mockDelete.mockRejectedValue(new Error("boom"))
    const res = await POST()
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, deletedPreviousSnapshot: false, previousSnapshotDeleteError: "boom" })
  })

  it("POST returns 500 and keeps the previous snapshot when the build fails", async () => {
    mockBuild.mockRejectedValue(new Error("build failed"))
    const res = await POST()
    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ ok: false, error: "build failed" })
    expect(mockSet).not.toHaveBeenCalled()
    expect(mockDelete).not.toHaveBeenCalled()
  })
})
