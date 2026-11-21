import { expect, it, vi } from "vitest"
import { withImportHeartbeat } from "@/lib/workspace-export/heartbeat"

it("renews while a provider call is outstanding and reports lost ownership before verification", async () => {
  vi.useFakeTimers()
  try {
    let finish!: () => void
    const pending = new Promise<void>(resolve => { finish = resolve })
    const renew = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValue(new Error("ownership changed"))
    const result = withImportHeartbeat(renew, () => pending, 100)
    await vi.advanceTimersByTimeAsync(250)
    expect(renew.mock.calls.length).toBeGreaterThanOrEqual(2)
    finish()
    await expect(result).rejects.toThrow("ownership changed")
    expect(vi.getTimerCount()).toBe(0)
  } finally { vi.useRealTimers() }
})
