/**
 * The client-side view of a run: lib/agent-run-stream.ts and
 * lib/agent-run-view.ts.
 *
 * The property that matters most here is **replay equivalence**: a tab that
 * reattaches to an in-flight run reads the durable event log from `afterSeq = 0`,
 * so folding the same events twice — or folding a prefix twice and then the tail —
 * has to produce the same transcript a live viewer saw. Every dedupe assertion
 * below is that property, not a style preference.
 */
import { describe, it, expect } from "vitest"
import {
  applyAgentSdkEvent,
  emptyAgentTurnState,
  runFailureText,
  settleSteps,
  type AgentTurnState,
} from "@/lib/agent-run-stream"
import { serializeAgentRun, serializeAgentRunEvent } from "@/lib/agent-run-view"

/** The Agent SDK envelope as it arrives through both transports. */
function sdk(...content: unknown[]) {
  return { type: "assistant", message: { message: { content } } }
}

function fold(payloads: unknown[], from: AgentTurnState = emptyAgentTurnState) {
  return payloads.reduce<AgentTurnState>((state, payload) => applyAgentSdkEvent(payload, state), from)
}

describe("applyAgentSdkEvent", () => {
  it("accumulates text across events and blocks in arrival order", () => {
    const state = fold([sdk({ type: "text", text: "Hello" }), sdk({ type: "text", text: ", " }, { type: "text", text: "world" })])
    expect(state.text).toBe("Hello, world")
    expect(state.steps).toEqual([])
  })

  it("records a tool_use as a running step with a humanized label", () => {
    const state = fold([sdk({ type: "tool_use", id: "t1", name: "mcp__compass__list_opportunities" })])
    expect(state.steps).toEqual([{ id: "t1", label: "List opportunities", status: "running" }])
  })

  it("completes the matching step when its tool_result lands", () => {
    const state = fold([
      sdk({ type: "tool_use", id: "t1", name: "mcp__compass__create_task" }),
      sdk({ type: "tool_use", id: "t2", name: "mcp__compass__list_tasks" }),
      sdk({ type: "tool_result", tool_use_id: "t2" }),
    ])
    expect(state.steps.map((step) => [step.id, step.status])).toEqual([
      ["t1", "running"],
      ["t2", "done"],
    ])
  })

  it("is replay-safe: re-folding the whole log yields the same state, not a doubled tool strip", () => {
    const log = [
      sdk({ type: "text", text: "one " }),
      sdk({ type: "tool_use", id: "t1", name: "mcp__compass__create_task" }),
      sdk({ type: "tool_result", tool_use_id: "t1" }),
    ]
    // A reattaching tab reads from seq 0; the steps must dedupe by tool_use id.
    const replayed = fold(log)
    expect(replayed.steps).toEqual([{ id: "t1", label: "Create task", status: "done" }])
    // Text is *not* idempotent and must not be — the transcript is the
    // concatenation of the events read, which is why the client replays from a
    // single cursor rather than merging two readers into one state.
    expect(fold(log, replayed).text).toBe("one one ")
  })

  it("keeps the same object identity when an event changes nothing, so no render is triggered", () => {
    const start = fold([sdk({ type: "text", text: "hi" })])
    expect(applyAgentSdkEvent(sdk(), start)).toBe(start)
    expect(applyAgentSdkEvent(sdk({ type: "text", text: "" }), start)).toBe(start)
    // A tool_result for a step that is not in this view (a truncated replay) is a
    // no-op rather than an error.
    expect(applyAgentSdkEvent(sdk({ type: "tool_result", tool_use_id: "nope" }), start)).toBe(start)
  })

  it("ignores payloads it cannot interpret instead of losing the turn", () => {
    for (const payload of [null, undefined, {}, { message: {} }, { message: { message: { content: "not an array" } } }]) {
      expect(applyAgentSdkEvent(payload, emptyAgentTurnState)).toBe(emptyAgentTurnState)
    }
    // An unknown block kind must not break the blocks around it.
    const state = fold([sdk({ type: "thinking", thinking: "…" }, { type: "text", text: "kept" })])
    expect(state.text).toBe("kept")
  })

  it("falls back to positional ids so an id-less tool_use still shows up once per event", () => {
    const state = fold([sdk({ type: "tool_use", name: "a_tool" }), sdk({ type: "tool_use", name: "b_tool" })])
    expect(state.steps.map((step) => step.id)).toEqual(["0", "1"])
  })
})

describe("settleSteps", () => {
  it("marks every step done without mutating the input", () => {
    const steps = [
      { id: "t1", label: "Create task", status: "running" as const },
      { id: "t2", label: "List tasks", status: "done" as const },
    ]
    expect(settleSteps(steps).every((step) => step.status === "done")).toBe(true)
    expect(steps[0].status).toBe("running")
  })
})

describe("runFailureText", () => {
  it("names cancellation plainly and never leaks a server error string into it", () => {
    expect(runFailureText("CANCELED", "worker token rejected")).toBe("Run canceled.")
  })
  it("reassures on an interrupt that the transcript survived", () => {
    expect(runFailureText("INTERRUPTED", null)).toContain("Your transcript is saved.")
    expect(runFailureText("INTERRUPTED", "The run exceeded its time budget.")).toBe("The run exceeded its time budget.")
  })
  it("falls back to a generic message when a failure reports no detail", () => {
    expect(runFailureText("FAILED", "   ")).toBe("The agent hit an error.")
    expect(runFailureText("FAILED", "sandbox quota exhausted")).toBe("sandbox quota exhausted")
  })
})

describe("serializeAgentRun", () => {
  const row = {
    id: "run-1",
    conversationId: "c-1",
    workspaceId: "ws-1",
    status: "RUNNING",
    kind: "CHAT",
    lastSeq: 7,
    eventCount: 7,
    deadlineAt: new Date("2026-09-25T12:00:00.000Z"),
    createdAt: new Date("2026-09-25T11:40:00.000Z"),
  }

  it("derives `done` from the status rather than trusting the client to know the enum", () => {
    expect(serializeAgentRun(row).done).toBe(false)
    expect(serializeAgentRun({ ...row, status: "QUEUED" }).done).toBe(false)
    for (const status of ["SUCCEEDED", "FAILED", "INTERRUPTED", "CANCELED"]) {
      expect(serializeAgentRun({ ...row, status }).done).toBe(true)
    }
  })

  it("renders dates as ISO strings and absent optionals as null, never undefined", () => {
    const json = serializeAgentRun(row)
    expect(json.deadlineAt).toBe("2026-09-25T12:00:00.000Z")
    expect(json.startedAt).toBeNull()
    expect(json.finishedAt).toBeNull()
    expect(json.lastHeartbeatAt).toBeNull()
    expect(json.error).toBeNull()
    // JSON.stringify would drop an undefined, so the reattach client would see the
    // key vanish rather than read null.
    expect(Object.values(json).every((value) => value !== undefined)).toBe(true)
  })

  it("passes usage through untouched when it is present", () => {
    const json = serializeAgentRun({
      ...row,
      status: "SUCCEEDED",
      model: "us.anthropic.claude-sonnet-4-6",
      inputTokens: 1_200,
      outputTokens: 340,
      numTurns: 3,
      costUsd: 0.0421,
      durationMs: 91_000,
      startedAt: new Date("2026-09-25T11:41:00.000Z"),
      finishedAt: new Date("2026-09-25T11:42:31.000Z"),
    })
    expect(json).toMatchObject({ inputTokens: 1_200, outputTokens: 340, numTurns: 3, costUsd: 0.0421, durationMs: 91_000 })
    expect(json.startedAt).toBe("2026-09-25T11:41:00.000Z")
  })
})

describe("serializeAgentRunEvent", () => {
  const base = { seq: 3, type: "agent", createdAt: new Date("2026-09-25T11:41:00.000Z") }

  it("parses the stored TEXT payload back into JSON", () => {
    const event = serializeAgentRunEvent({ ...base, payloadJson: JSON.stringify({ message: { message: { content: [] } } }) })
    expect(event).toEqual({ seq: 3, type: "agent", payload: { message: { message: { content: [] } } }, createdAt: "2026-09-25T11:41:00.000Z" })
  })

  it("surfaces unparseable text as { raw } so one bad row cannot poison a transcript", () => {
    const event = serializeAgentRunEvent({ ...base, payloadJson: "{not json" })
    expect(event.payload).toEqual({ raw: "{not json" })
  })
})
