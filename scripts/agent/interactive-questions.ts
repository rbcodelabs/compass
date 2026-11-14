// Sandbox-side hold-open `AskUserQuestion` coordinator.
// Executed directly by Node 24 inside the sandbox (`node entry.ts`), so every construct
// MUST stay strip-only TypeScript safe (see __tests__/agent-entry-scripts.test.ts).

import type { RunReporter } from "./run-reporter.ts"

export type SandboxQuestionOption = {
  label: string
  description?: string
}

export type SandboxQuestionItem = {
  question: string
  header?: string
  options?: SandboxQuestionOption[]
  multiSelect?: boolean
  allowOther?: boolean
}

export const DEADLINE_PARK_BUFFER_MS = 30_000
const POLL_WAIT_SLICE_MS = 1_500

export type AskUserQuestionsResult = {
  answers: Record<string, string>
  formattedText: string
}

type CreatedQuestionsResponse = {
  questions?: { id: string; question: string; header: string | null }[]
  deadlineAt?: string
  error?: string
}

/**
 * Registers structured questions on `/api/internal/agent/runs/:runId/questions`, switches
 * `RunReporter` into 2s fast-polling mode, and awaits human answers over the heartbeat loop.
 *
 * If the run's wall-clock deadline approaches (`deadlineAt - 30s`) before all questions are
 * answered, invokes `onDeadlinePark` so `turn-entry.ts` aborts `query()`, saves docs + the
 * SDK session transcript, and parks cleanly as `INTERRUPTED` (`AWAITING_USER`).
 */
export async function askUserQuestionsInRun(opts: {
  baseUrl: string
  runId: string
  headers: Record<string, string>
  reporter: RunReporter
  nativeToolUseId?: string
  questions: SandboxQuestionItem[]
  onDeadlinePark: (reason: string) => void
  now?: () => number
}): Promise<AskUserQuestionsResult> {
  const clock = opts.now ?? Date.now
  const url = new URL(`/api/internal/agent/runs/${opts.runId}/questions`, opts.baseUrl).toString()

  let created: CreatedQuestionsResponse | null = null
  let lastStatus = 0
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const response = await fetch(url, {
      method: "POST",
      headers: { ...opts.headers, "content-type": "application/json" },
      body: JSON.stringify({
        nativeToolUseId: opts.nativeToolUseId,
        questions: opts.questions,
      }),
    })
    lastStatus = response.status
    const parsed = (await response.json().catch(() => null)) as CreatedQuestionsResponse | null
    if (response.ok && parsed?.questions && parsed.questions.length > 0) {
      created = parsed
      break
    }
    if (response.status >= 400 && response.status < 500 && response.status !== 429) {
      throw new Error(parsed?.error ?? `AskUserQuestion registration failed with HTTP ${response.status}`)
    }
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 350))
  }

  if (!created?.questions || created.questions.length === 0) {
    throw new Error(`AskUserQuestion registration failed (HTTP ${lastStatus})`)
  }

  const questionIds = created.questions.map((q) => q.id)
  let deadlineMs = created.deadlineAt ? Date.parse(created.deadlineAt) : Number.NaN

  opts.reporter.setFastPolling(true)
  try {
    for (;;) {
      if (opts.reporter.canceledStatus) {
        throw new Error(`Run terminated while waiting for user answer (${opts.reporter.canceledStatus})`)
      }

      if (opts.reporter.latestDeadlineAt) {
        const refreshed = Date.parse(opts.reporter.latestDeadlineAt)
        if (!Number.isNaN(refreshed)) deadlineMs = refreshed
      }

      const byId = new Map(opts.reporter.latestQuestions.map((q) => [q.id, q]))
      const allResolved = questionIds.every((id) => {
        const snap = byId.get(id)
        return snap !== undefined && snap.status !== "PENDING"
      })

      if (allResolved) {
        const answers: Record<string, string> = {}
        const lines: string[] = []
        for (const original of created.questions) {
          const snap = byId.get(original.id)
          const text = snap?.status === "ANSWERED" ? (snap.answerText ?? "") : "(dismissed)"
          answers[original.question] = text
          lines.push(`${original.header ? `[${original.header}] ` : ""}${original.question}\nUser answered: ${text}`)
        }
        return {
          answers,
          formattedText: `User answered your question(s):\n\n${lines.join("\n\n")}`,
        }
      }

      if (!Number.isNaN(deadlineMs) && clock() >= deadlineMs - DEADLINE_PARK_BUFFER_MS) {
        const parkReason =
          "Paused waiting for your answer — submit your answer above to resume where the agent left off."
        opts.onDeadlinePark(parkReason)
        throw new Error(parkReason)
      }

      await opts.reporter.waitForHeartbeatUpdate(POLL_WAIT_SLICE_MS)
    }
  } finally {
    opts.reporter.setFastPolling(false)
  }
}
