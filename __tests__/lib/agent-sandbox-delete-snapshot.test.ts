/**
 * Unit tests for deleteGoldenSnapshot() in lib/agent-sandbox.ts.
 *
 * This is the cleanup half of the golden-snapshot lifecycle: every rebuild
 * (POST /api/admin/rebuild-agent-snapshot) must delete the *previous* golden
 * snapshot after the new one is persisted, or ~450MB snapshots accumulate
 * forever and eventually exhaust the team's Snapshot Storage quota (the
 * incident that motivated this fix — see route.ts's doc comment).
 *
 * Mocks @vercel/sandbox's `Snapshot.get(...).delete()` — never hits real
 * Vercel infra from tests.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

const m = vi.hoisted(() => ({ get: vi.fn(), del: vi.fn() }))
vi.mock("@vercel/sandbox", () => ({
  Sandbox: { create: vi.fn() },
  Snapshot: { get: m.get },
}))

import { deleteGoldenSnapshot } from "@/lib/agent-sandbox"

beforeEach(() => {
  vi.clearAllMocks()
  m.get.mockResolvedValue({ delete: m.del })
  m.del.mockResolvedValue(undefined)
})

describe("deleteGoldenSnapshot", () => {
  it("fetches the snapshot by id and deletes it", async () => {
    await deleteGoldenSnapshot("snap_old123")
    expect(m.get).toHaveBeenCalledWith({ snapshotId: "snap_old123" })
    expect(m.del).toHaveBeenCalledTimes(1)
  })

  it("propagates a fetch failure to the caller (caller decides best-effort handling)", async () => {
    m.get.mockRejectedValue(new Error("snapshot not found"))
    await expect(deleteGoldenSnapshot("snap_missing")).rejects.toThrow("snapshot not found")
    expect(m.del).not.toHaveBeenCalled()
  })

  it("propagates a delete failure to the caller", async () => {
    m.del.mockRejectedValue(new Error("delete forbidden"))
    await expect(deleteGoldenSnapshot("snap_old123")).rejects.toThrow("delete forbidden")
  })
})
