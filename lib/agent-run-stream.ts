/**
 * Client-side accumulation of an agent turn's events.
 *
 * The same Agent SDK message shape now arrives through two transports: the
 * synchronous SSE stream a pre-migration turn still uses, and the durable event
 * log a detached run writes. Interpreting it twice is how the two views of one
 * turn drift apart, so the interpretation lives here and both callers reduce
 * through it.
 *
 * Pure and immutable on purpose: reattaching to a run means replaying its events
 * from `afterSeq = 0`, and a reducer that mutates shared state cannot be replayed.
 */

import { humanizeToolName } from "@/lib/agent-tools"

export type StepStatus = "running" | "done" | "error"

export type ToolStep = {
  id: string
  label: string
  status: StepStatus
  /** One-line summary of the call's input (a query, a URL, an id), when it has an obvious one. */
  detail?: string
  /** The tool result's text, trimmed; shown when the step is expanded. */
  result?: string
}

export type PlanItemStatus = "pending" | "in_progress" | "completed"

/** One entry of the agent's TodoWrite list. */
export type PlanItem = { content: string; activeForm: string; status: PlanItemStatus }

export type Subagent = {
  /** The id of the Task/Agent tool_use that spawned it; children point back here via parent_tool_use_id. */
  id: string
  description: string
  agentType: string
  status: StepStatus
  /** The subagent's own tool calls, in order. */
  steps: ToolStep[]
  /** The subagent's final report, once its tool_result lands. */
  summary?: string
}

export type AgentTurnState = {
  /** Assistant text assembled so far (top-level only; subagent chatter is not the reply). */
  text: string
  /** Top-level tool calls in the order they were issued, settled once their result lands. */
  steps: ToolStep[]
  /** The latest TodoWrite list — each call replaces the whole list. */
  plan: PlanItem[]
  /** Subagents (Task/Agent tool calls) in the order they were spawned. */
  subagents: Subagent[]
  /** The SDK's predicted next user prompt, if the turn produced one. */
  suggestion?: string
}

export const emptyAgentTurnState: AgentTurnState = { text: "", steps: [], plan: [], subagents: [] }

const PLAN_TOOL = "TodoWrite"
const SUBAGENT_TOOLS = new Set(["Task", "Agent"])
const DETAIL_KEYS = ["query", "url", "path", "file_path", "pattern", "id", "name", "title", "slug"]

function clip(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** A short, human line for a tool call's input: the first obvious scalar field. */
function summarizeInput(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined
  const record = input as Record<string, unknown>
  for (const key of DETAIL_KEYS) {
    const value = record[key]
    if (typeof value === "string" && value.trim()) return clip(`${key}: ${value}`, 140)
  }
  return undefined
}

/** Tool results arrive as a string or as an array of text blocks. */
function resultText(content: unknown): string | undefined {
  if (typeof content === "string") return content.trim() ? clip(content, 600) : undefined
  if (Array.isArray(content)) {
    const joined = content
      .map((block) => (block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string" ? (block as { text: string }).text : ""))
      .join("\n")
    return joined.trim() ? clip(joined, 600) : undefined
  }
  return undefined
}

function parsePlan(input: unknown): PlanItem[] | null {
  const todos = (input as { todos?: unknown } | null | undefined)?.todos
  if (!Array.isArray(todos)) return null
  const items: PlanItem[] = []
  for (const raw of todos as Record<string, unknown>[]) {
    if (typeof raw?.content !== "string") continue
    const status: PlanItemStatus = raw.status === "completed" || raw.status === "in_progress" ? raw.status : "pending"
    items.push({ content: raw.content, activeForm: typeof raw.activeForm === "string" && raw.activeForm ? raw.activeForm : raw.content, status })
  }
  return items
}

function settleStep(steps: ToolStep[], id: string, isError: boolean, result: string | undefined): ToolStep[] {
  // Guarded so a result for a step this view does not hold — a truncated
  // replay, or a re-read of an already-settled step — returns the array
  // unchanged rather than a fresh one that only looks different.
  if (!steps.some((step) => step.id === id && step.status === "running")) return steps
  return steps.map((step) =>
    step.id === id ? { ...step, status: isError ? ("error" as const) : ("done" as const), ...(result ? { result } : {}) } : step,
  )
}

/**
 * Fold one `agent` event into the turn state.
 *
 * Unknown block types are ignored rather than rejected: the payload is whatever
 * the Agent SDK emitted, and a new block kind must not break the transcript of a
 * turn that is otherwise fine.
 *
 * Messages carrying a `parent_tool_use_id` were produced inside a subagent: their
 * tool calls nest under it and their text is not part of the reply.
 */
export function applyAgentSdkEvent(payload: unknown, state: AgentTurnState): AgentTurnState {
  const envelope = payload as { message?: { type?: string; suggestion?: unknown; parent_tool_use_id?: unknown; message?: { content?: unknown } } } | null | undefined
  if (envelope?.message?.type === "prompt_suggestion") {
    const suggestion = typeof envelope.message.suggestion === "string" ? envelope.message.suggestion.trim() : ""
    return suggestion && suggestion !== state.suggestion ? { ...state, suggestion } : state
  }
  const content = envelope?.message?.message?.content
  if (!Array.isArray(content)) return state
  const parentId = typeof envelope?.message?.parent_tool_use_id === "string" ? envelope.message.parent_tool_use_id : null

  let { text, steps, plan, subagents } = state
  for (const raw of content as Record<string, unknown>[]) {
    if (raw?.type === "text" && typeof raw.text === "string") {
      if (!parentId) text += raw.text
    } else if (raw?.type === "tool_use" && typeof raw.name === "string") {
      const id = String(raw.id ?? steps.length)
      if (parentId) {
        const owner = subagents.find((agent) => agent.id === parentId)
        if (owner && !owner.steps.some((step) => step.id === id)) {
          const step: ToolStep = { id, label: humanizeToolName(raw.name), status: "running", detail: summarizeInput(raw.input) }
          subagents = subagents.map((agent) => (agent === owner ? { ...agent, steps: [...agent.steps, step] } : agent))
        }
      } else if (raw.name === PLAN_TOOL) {
        const next = parsePlan(raw.input)
        if (next) plan = next
      } else if (SUBAGENT_TOOLS.has(raw.name)) {
        if (!subagents.some((agent) => agent.id === id)) {
          const input = (raw.input ?? {}) as Record<string, unknown>
          const description = typeof input.description === "string" && input.description ? input.description : "Subagent"
          const agentType = typeof input.subagent_type === "string" && input.subagent_type ? input.subagent_type : "general-purpose"
          subagents = [...subagents, { id, description, agentType, status: "running", steps: [] }]
        }
      } else if (!steps.some((step) => step.id === id)) {
        // Replay-safe: the same tool_use arriving twice (a re-read of the event log)
        // must not produce two rows in the tool strip.
        steps = [...steps, { id, label: humanizeToolName(raw.name), status: "running", detail: summarizeInput(raw.input) }]
      }
    } else if (raw?.type === "tool_result") {
      const id = String(raw.tool_use_id ?? "")
      const isError = raw.is_error === true
      const result = resultText(raw.content)
      const agent = subagents.find((candidate) => candidate.id === id)
      if (agent) {
        if (agent.status === "running") {
          subagents = subagents.map((candidate) =>
            candidate === agent ? { ...candidate, status: isError ? "error" : "done", ...(result ? { summary: result } : {}) } : candidate,
          )
        }
      } else if (parentId) {
        const owner = subagents.find((candidate) => candidate.id === parentId)
        if (owner) {
          const settled = settleStep(owner.steps, id, isError, result)
          if (settled !== owner.steps) subagents = subagents.map((candidate) => (candidate === owner ? { ...candidate, steps: settled } : candidate))
        }
      } else {
        steps = settleStep(steps, id, isError, result)
      }
    }
  }
  return text === state.text && steps === state.steps && plan === state.plan && subagents === state.subagents
    ? state
    : { ...state, text, steps, plan, subagents }
}

/** Every still-running step marked done — what a finished turn's transcript row should show. Failures stay failures. */
export function settleSteps(steps: ToolStep[]): ToolStep[] {
  return steps.map((step) => (step.status === "running" ? { ...step, status: "done" as const } : step))
}

/** A finished turn's activity: nothing left running, plan items that were in flight stay as the agent left them. */
export function settleActivity(state: AgentTurnState): Pick<AgentTurnState, "steps" | "plan" | "subagents"> {
  return {
    steps: settleSteps(state.steps),
    plan: state.plan,
    subagents: state.subagents.map((agent) => ({
      ...agent,
      status: agent.status === "running" ? ("done" as const) : agent.status,
      steps: settleSteps(agent.steps),
    })),
  }
}

export type RunStatus = "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "INTERRUPTED" | "CANCELED"

export type SerializedRun = {
  id: string
  conversationId: string
  status: RunStatus
  lastSeq: number
  done: boolean
  error: string | null
  errorCode: string | null
  deadlineAt: string
  /** Who sent the turn this run answers. Absent from an older server. */
  startedByUserId?: string | null
  /** The cloud agent that answers this run; absent or null = the built-in agent. */
  agentName?: string | null
  /** The model the run answers on (recorded when it starts); absent or null from an older server or run. */
  model?: string | null
}

/** The banner text for a run that ended without a result of its own. */
export function runFailureText(status: RunStatus, error: string | null): string {
  if (status === "CANCELED") return "Run canceled."
  if (status === "INTERRUPTED") {
    return error?.trim() || "The run stopped before it finished. Your transcript is saved."
  }
  return error?.trim() || "The agent hit an error."
}
