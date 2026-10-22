import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { announceAgentRun } from "@/lib/ui/agent-run-toast"
import { getUndoToasts, resetUndoToasts } from "@/lib/ui/undo-toast"

beforeEach(() => resetUndoToasts())
afterEach(() => resetUndoToasts())

describe("announceAgentRun", () => {
  it("says nothing for no outcome or a skipped one", () => {
    announceAgentRun(null)
    announceAgentRun(undefined)
    announceAgentRun({ status: "skipped" })
    expect(getUndoToasts()).toHaveLength(0)
  })

  it("confirms a started run with a way to follow it", () => {
    announceAgentRun({ status: "started", agentName: "Triage", conversationUrl: "/o/w/agent?c=c1" })
    const [toast] = getUndoToasts()
    expect(toast.message).toBe("Started a run as Triage.")
    expect(toast.actionLabel).toBe("View run")
    expect(toast.onAction).toBeTypeOf("function")
  })

  it("says a run is already going, rather than starting another", () => {
    announceAgentRun({ status: "already_running", agentName: "Triage", conversationUrl: "/o/w/agent?c=c1" })
    expect(getUndoToasts()[0].message).toBe("Triage is already working on this task.")
  })

  it("shows the refusal sentence, with no action, and keeps it up longer than a confirmation", () => {
    announceAgentRun({ status: "refused", message: "The task was assigned to Triage, but no run started: limit 5." })
    const [toast] = getUndoToasts()
    expect(toast.message).toContain("no run started")
    expect(toast.onAction).toBeUndefined()
    expect(toast.durationMs).toBeGreaterThan(12000 - 1)
  })
})
