import { afterEach, describe, expect, it, vi } from "vitest"
import { askUserQuestionsInRun, DEADLINE_PARK_BUFFER_MS } from "@/scripts/agent/interactive-questions"
import type { HeartbeatQuestionSnapshot, RunReporter } from "@/scripts/agent/run-reporter"

function createFakeReporter() {
  const fastPollingLog: boolean[] = []
  const state = {
    canceledStatus: undefined as string | undefined,
    latestQuestions: [] as HeartbeatQuestionSnapshot[],
    latestDeadlineAt: undefined as string | undefined,
    onWait: undefined as (() => void) | undefined,
  }
  const reporter = {
    get canceledStatus() {
      return state.canceledStatus
    },
    get latestQuestions() {
      return state.latestQuestions
    },
    get latestDeadlineAt() {
      return state.latestDeadlineAt
    },
    setFastPolling(enabled: boolean) {
      fastPollingLog.push(enabled)
    },
    async waitForHeartbeatUpdate() {
      state.onWait?.()
    },
  } as unknown as RunReporter

  return { reporter, state, fastPollingLog }
}

describe("scripts/agent/interactive-questions", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("toggles fast-polling, picks up heartbeat answers, and restores normal heartbeat cadence", async () => {
    const { reporter, state, fastPollingLog } = createFakeReporter()
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          questions: [{ id: "q-1", header: "Scope", question: "Ship to all users?" }],
          deadlineAt: "2026-11-14T12:20:00.000Z",
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      ),
    )

    state.onWait = () => {
      state.latestQuestions = [
        {
          id: "q-1",
          header: "Scope",
          question: "Ship to all users?",
          status: "ANSWERED",
          answerText: "Start with 10% canary",
        },
      ]
    }

    const onDeadlinePark = vi.fn()
    const res = await askUserQuestionsInRun({
      baseUrl: "https://compass.test",
      runId: "run-1",
      headers: { Authorization: "Bearer tok" },
      reporter,
      nativeToolUseId: "tool-1",
      questions: [{ header: "Scope", question: "Ship to all users?" }],
      onDeadlinePark,
      now: () => Date.parse("2026-11-14T12:00:00.000Z"),
    })

    expect(fastPollingLog).toEqual([true, false])
    expect(onDeadlinePark).not.toHaveBeenCalled()
    expect(res.answers).toEqual({ "Ship to all users?": "Start with 10% canary" })
    expect(res.formattedText).toContain("[Scope] Ship to all users?")
    expect(res.formattedText).toContain("Start with 10% canary")
  })

  it("invokes onDeadlinePark when clock reaches deadlineAt - 30s without an answer", async () => {
    const { reporter, fastPollingLog } = createFakeReporter()
    const deadlineMs = Date.parse("2026-11-14T12:10:00.000Z")
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          questions: [{ id: "q-2", header: null, question: "Approve schema?" }],
          deadlineAt: new Date(deadlineMs).toISOString(),
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      ),
    )

    const onDeadlinePark = vi.fn()
    await expect(
      askUserQuestionsInRun({
        baseUrl: "https://compass.test",
        runId: "run-2",
        headers: { Authorization: "Bearer tok" },
        reporter,
        questions: [{ question: "Approve schema?" }],
        onDeadlinePark,
        now: () => deadlineMs - DEADLINE_PARK_BUFFER_MS,
      }),
    ).rejects.toThrow(/Paused waiting for your answer/)

    expect(onDeadlinePark).toHaveBeenCalledTimes(1)
    expect(fastPollingLog).toEqual([true, false])
  })
})
