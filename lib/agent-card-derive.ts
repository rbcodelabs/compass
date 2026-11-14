/**
 * Pure derivation helpers for rich agent board cards and chat-list rows:
 *  - live `currentActivity` from incoming `AgentRunEvent` batches,
 *  - 1-line markdown-stripped `summary` from completed assistant turns,
 *  - latest GitHub pull-request URL (`prUrl`) and display badge (`#123`).
 */

import { humanizeToolName } from "@/lib/agent-tools"

export const CURRENT_ACTIVITY_MAX = 240
export const CONVERSATION_SUMMARY_MAX = 240
export const PR_URL_MAX = 500

const SUBAGENT_TOOLS = new Set(["Task", "Agent"])
const DETAIL_KEYS = ["query", "title", "name", "path", "file_path", "pattern", "url", "id", "slug", "command"]
const GITHUB_PR_RE = /https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)/g

function clip(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim()
  if (!flat) return ""
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat
}

function summarizeToolInput(input: unknown): string | null {
  if (!input || typeof input !== "object") return null
  const record = input as Record<string, unknown>
  for (const key of DETAIL_KEYS) {
    const value = record[key]
    if (typeof value === "string" && value.trim()) {
      return clip(value, 80)
    }
  }
  return null
}

function activityFromAgentPayload(payload: unknown, redactArgs: boolean): string | null {
  const envelope = payload as { message?: { message?: { content?: unknown } } } | null | undefined
  const content = envelope?.message?.message?.content
  if (!Array.isArray(content)) return null

  let latest: string | null = null
  for (const raw of content as Record<string, unknown>[]) {
    if (raw?.type !== "tool_use" || typeof raw.name !== "string") continue
    const input = (raw.input ?? {}) as Record<string, unknown>

    if (SUBAGENT_TOOLS.has(raw.name)) {
      const desc = !redactArgs && typeof input.description === "string" && input.description.trim()
        ? clip(input.description, 120)
        : "Subagent"
      latest = clip(`Subagent: ${desc}`, CURRENT_ACTIVITY_MAX)
      continue
    }

    if (raw.name === "TodoWrite" && !redactArgs && Array.isArray(input.todos)) {
      const active = (input.todos as Record<string, unknown>[]).find((item) => item?.status === "in_progress")
      const label = typeof active?.activeForm === "string" && active.activeForm.trim()
        ? active.activeForm
        : typeof active?.content === "string"
          ? active.content
          : null
      if (label) {
        latest = clip(label, CURRENT_ACTIVITY_MAX)
        continue
      }
    }

    const label = humanizeToolName(raw.name)
    const detail = redactArgs ? null : summarizeToolInput(raw.input)
    latest = clip(detail ? `${label} · ${detail}` : label, CURRENT_ACTIVITY_MAX)
  }
  return latest || null
}

/**
 * Extracts the latest human-readable activity step from a batch of newly-accepted run events.
 * Returns `null` when the batch carries no new activity, leaving the previous `currentActivity` intact.
 */
export function deriveLatestRunActivity(
  events: readonly { type: string; payloadJson: string }[],
  { redactArgs = false }: { redactArgs?: boolean } = {},
): string | null {
  let latest: string | null = null
  for (const event of events) {
    if (event.type === "status") {
      try {
        const parsed = JSON.parse(event.payloadJson) as { phase?: unknown }
        if (parsed?.phase === "booting") latest = "Starting sandbox…"
      } catch {
        /* ignore malformed status payload */
      }
      continue
    }
    if (event.type === "agent") {
      try {
        const step = activityFromAgentPayload(JSON.parse(event.payloadJson), redactArgs)
        if (step) latest = step
      } catch {
        /* ignore malformed agent payload */
      }
    }
  }
  return latest
}

/**
 * Strips Markdown chrome (fenced code blocks, headings, links, list prefixes, inline emphasis)
 * down to a clean single-line card summary.
 */
export function deriveConversationSummary(
  markdown: string | null | undefined,
  maxChars: number = CONVERSATION_SUMMARY_MAX,
): string | null {
  if (typeof markdown !== "string" || !markdown.trim()) return null
  const stripped = markdown
    // Remove fenced code blocks completely so code snippets don't crowd out prose
    .replace(/```[\s\S]*?```/g, " ")
    // Images -> alt text or drop
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    // Links -> link text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    // Headings, blockquotes, horizontal rules, list bullets at start of line
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s+|[-*+]\s+|\d+\.\s+|---+|\*\*\*+)/gm, "")
    // Inline code and emphasis markers
    .replace(/`([^`]+)`/g, "$1")
    .replace(/(\*\*|__|\*|_|\~\~)/g, "")
  const line = clip(stripped, maxChars)
  return line || null
}

/** Returns the last GitHub pull-request URL mentioned in `text`, or `null` if none. */
export function extractLatestPrUrl(text: string | null | undefined): string | null {
  if (typeof text !== "string" || !text) return null
  let latest: string | null = null
  for (const match of text.matchAll(GITHUB_PR_RE)) {
    const candidate = match[0]
    if (candidate.length > PR_URL_MAX) continue
    try {
      const parsed = new URL(candidate)
      if (parsed.protocol === "https:" && parsed.hostname === "github.com") {
        latest = candidate
      }
    } catch {
      // Ignore malformed URL matches
    }
  }
  return latest
}

/** Formats a GitHub PR URL as `repo#123` or `#123` for compact card chips. */
export function formatPrBadge(prUrl: string | null | undefined): { number: string; repo: string; label: string } | null {
  if (typeof prUrl !== "string") return null
  const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)$/.exec(prUrl.trim())
  if (!match) return null
  return { number: match[3], repo: `${match[1]}/${match[2]}`, label: `PR #${match[3]}` }
}
