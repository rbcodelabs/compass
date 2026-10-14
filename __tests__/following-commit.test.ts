import { afterEach, describe, expect, it, vi } from "vitest"
import { runAfterCommit, withFollowingCommit } from "@/lib/following-commit"

afterEach(() => vi.restoreAllMocks())

describe("commit-scoped following queue", () => {
  it("runs work immediately when there is no commit scope", async () => {
    const work = vi.fn().mockResolvedValue(undefined)
    await runAfterCommit(work)
    expect(work).toHaveBeenCalledTimes(1)
  })

  it("holds work until the wrapped transaction has resolved, then flushes in order", async () => {
    const order: string[] = []
    await withFollowingCommit(async () => {
      await runAfterCommit(async () => { order.push("first") })
      await runAfterCommit(async () => { order.push("second") })
      order.push("transaction body done")
    })
    expect(order).toEqual(["transaction body done", "first", "second"])
  })

  it("discards queued work when the transaction rolls back (the wrapped work throws)", async () => {
    const work = vi.fn().mockResolvedValue(undefined)
    await expect(withFollowingCommit(async () => {
      await runAfterCommit(work)
      throw new Error("receipt superseded")
    })).rejects.toThrow("receipt superseded")
    expect(work).not.toHaveBeenCalled()
  })

  it("returns the wrapped result and survives a failing queued effect", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const after = vi.fn().mockResolvedValue(undefined)
    const result = await withFollowingCommit(async () => {
      await runAfterCommit(async () => { throw new Error("emit blew up") })
      await runAfterCommit(after)
      return "ok"
    })
    expect(result).toBe("ok")
    expect(after).toHaveBeenCalledTimes(1)
  })

  it("does not leak the scope to unrelated later calls", async () => {
    await withFollowingCommit(async () => undefined)
    const work = vi.fn().mockResolvedValue(undefined)
    await runAfterCommit(work)
    expect(work).toHaveBeenCalledTimes(1)
  })
})
