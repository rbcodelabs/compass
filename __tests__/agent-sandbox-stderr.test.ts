/**
 * Sandbox stderr capture.
 *
 * The behaviour under test is what a developer reads when an agent turn dies
 * for a reason the entry script never got to report. Before this, that was
 * `agent process exited with code 1` and nothing else — the cause had been
 * printed to stderr and dropped one branch earlier in the log loop.
 */
import { describe, it, expect } from "vitest"

import { appendStderr, BoundedStderr, MAX_STDERR_CHARS } from "@/lib/agent-sandbox-stderr"

describe("appendStderr", () => {
  it("returns the base message unchanged when nothing was captured", () => {
    expect(appendStderr("agent process exited with code 1", [])).toBe(
      "agent process exited with code 1",
    )
  })

  it.each([
    ["only whitespace", ["   ", "\n\t"]],
    ["empty strings", ["", ""]],
  ])("returns the base message unchanged for %s", (_label, chunks) => {
    // An empty `stderr:` heading would imply the sandbox said something it did
    // not, which is its own thing to debug around later.
    expect(appendStderr("boom", chunks)).toBe("boom")
  })

  it("folds captured stderr in under a labelled heading", () => {
    const message = appendStderr("agent process exited with code 1", [
      "Error: Cannot find module 'foo'\n",
    ])
    expect(message).toBe(
      "agent process exited with code 1\n\nstderr:\nError: Cannot find module 'foo'",
    )
  })

  it("reassembles chunks split mid-line, as the log stream delivers them", () => {
    // The sandbox log stream chunks on transport boundaries, not line
    // boundaries, so a stack frame routinely arrives in pieces.
    const message = appendStderr("boom", ["Error: Cann", "ot find modu", "le 'foo'"])
    expect(message).toContain("Error: Cannot find module 'foo'")
  })

  it("truncates past the cap and says how much there was", () => {
    const message = appendStderr("boom", ["x".repeat(MAX_STDERR_CHARS + 500)])
    expect(message).toContain(`… (truncated, ${MAX_STDERR_CHARS + 500} chars total)`)
    // The bound is on the stderr body, so the whole message is the base plus
    // the heading plus at most MAX_STDERR_CHARS of payload.
    expect(message.length).toBeLessThan(MAX_STDERR_CHARS + 200)
  })

  it("does not truncate at exactly the cap", () => {
    const message = appendStderr("boom", ["x".repeat(MAX_STDERR_CHARS)])
    expect(message).not.toContain("truncated")
    expect(message).toContain("x".repeat(MAX_STDERR_CHARS))
  })
})

describe("BoundedStderr", () => {
  it("folds captured output into the error message", () => {
    const stderr = new BoundedStderr()
    stderr.push("Error: EACCES\n")
    expect(stderr.toMessage("agent process exited with code 1")).toBe(
      "agent process exited with code 1\n\nstderr:\nError: EACCES",
    )
  })

  it("leaves the message alone when the sandbox wrote nothing to stderr", () => {
    expect(new BoundedStderr().toMessage("boom")).toBe("boom")
  })

  it("stops accumulating at the limit instead of growing without bound", () => {
    // The route's stdout buffer is capped at 1MB for the same reason: a sandbox
    // in a crash loop can emit the same trace indefinitely, and an unbounded
    // array of it lives inside a request handler.
    const stderr = new BoundedStderr(100)
    for (let i = 0; i < 1000; i++) stderr.push("y".repeat(100))
    const message = stderr.toMessage("boom")
    expect(message).toContain("y".repeat(100))
    expect(message).toContain("further stderr chars dropped at the capture limit")
    // 100 kept + the base, heading, and the dropped-count note — nowhere near
    // the 100,000 chars pushed.
    expect(message.length).toBeLessThan(400)
  })

  it("reports the exact number of characters dropped", () => {
    const stderr = new BoundedStderr(10)
    stderr.push("0123456789")  // exactly fills it
    stderr.push("abcde")       // all dropped
    expect(stderr.toMessage("boom")).toContain("(5 further stderr chars dropped")
  })

  it("splits the chunk that straddles the limit rather than dropping it whole", () => {
    const stderr = new BoundedStderr(10)
    stderr.push("0123456789abcde")
    const message = stderr.toMessage("boom")
    expect(message).toContain("0123456789")
    expect(message).not.toContain("abcde")
    expect(message).toContain("(5 further stderr chars dropped")
  })

  it("keeps the earliest output, where the original cause is", () => {
    // Later stderr is usually consequences of the first failure, so a prefix is
    // more useful than a sliding window of the tail.
    const stderr = new BoundedStderr(20)
    stderr.push("FIRST: real cause\n")
    stderr.push("SECOND: cascade\n")
    const message = stderr.toMessage("boom")
    expect(message).toContain("FIRST: real cause")
    expect(message).not.toContain("SECOND")
  })

  it("adds no dropped-count note when nothing was dropped", () => {
    const stderr = new BoundedStderr(100)
    stderr.push("short")
    expect(stderr.toMessage("boom")).not.toContain("dropped")
  })

  it("adds no dropped-count note when every captured chunk was whitespace", () => {
    // Nothing legible was captured, so there is no stderr section to annotate —
    // a bare "chars dropped" line hanging off the base message would be noise.
    const stderr = new BoundedStderr(4)
    stderr.push("    ")
    stderr.push("more that gets dropped")
    expect(stderr.toMessage("boom")).toBe("boom")
  })
})
