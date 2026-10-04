import { createHash } from "node:crypto"
import { normalizeResearchAppUrl } from "@/lib/research"
import {
  EXTERNAL_PROVIDERS, EXTERNAL_PROVIDER_LABELS, EXTERNAL_PROVENANCE, MAX_EXTERNAL_NOTES_CHARS, MAX_EXTERNAL_TRANSCRIPT_CHARS, MAX_EXTERNAL_TURNS,
  type ExternalProvider,
} from "@/lib/research-external-constants"

// Re-exported so server callers keep one import site; client components import the constants module directly
// (this file pulls in node:crypto, which must never reach a client bundle).
export { EXTERNAL_PROVIDERS, EXTERNAL_PROVIDER_LABELS, EXTERNAL_PROVENANCE, MAX_EXTERNAL_NOTES_CHARS, MAX_EXTERNAL_TRANSCRIPT_CHARS, MAX_EXTERNAL_TURNS }
export type { ExternalProvider }

/**
 * Pure validation and parsing for external / manual research studies: research that
 * was run outside Compass's AI interviewer (UserTesting, Maze, a call the team ran)
 * and pasted in by a workspace member.
 *
 * Everything entered here is MEMBER-REPORTED. Compass does not authenticate it
 * against the provider, which is why imported sessions carry `provenance =
 * EXTERNAL_IMPORT` and the UI labels them as such.
 */
export class ExternalResearchInputError extends Error {}

export function externalProviderLabel(value: string | null | undefined): string {
  return isExternalProvider(value) ? EXTERNAL_PROVIDER_LABELS[value] : "Other / manual"
}

const MAX_TURN_CHARS = 4_000
const MAX_URL_CHARS = 2_000

export function isExternalProvider(value: unknown): value is ExternalProvider {
  return typeof value === "string" && (EXTERNAL_PROVIDERS as readonly string[]).includes(value)
}

function optionalUrl(value: unknown, label: string): string | null {
  const raw = String(value ?? "").trim()
  if (!raw) return null
  if (raw.length > MAX_URL_CHARS) throw new ExternalResearchInputError(`${label} must be ${MAX_URL_CHARS} characters or fewer`)
  try {
    return normalizeResearchAppUrl(raw, { production: true })
  } catch (error) {
    throw new ExternalResearchInputError(`${label}: ${(error as Error).message.replace(/^Enter a valid product URL$/, "enter a valid https link").replace("Product URL", "link")}`)
  }
}

export type ExternalStudyInput = { name: string; goal: string; externalProvider: ExternalProvider; externalUrl: string | null }

export function normalizeExternalStudyInput(input: { name?: unknown; goal?: unknown; externalProvider?: unknown; externalUrl?: unknown }): ExternalStudyInput {
  const name = String(input.name ?? "").trim()
  const goal = String(input.goal ?? "").trim()
  if (!name) throw new ExternalResearchInputError("Enter a study name")
  if (name.length > 255) throw new ExternalResearchInputError("Study name must be 255 characters or fewer")
  if (!goal) throw new ExternalResearchInputError("Enter a research goal")
  if (goal.length > 5_000) throw new ExternalResearchInputError("Study goal must be 5,000 characters or fewer")
  if (!isExternalProvider(input.externalProvider)) throw new ExternalResearchInputError("Choose where this study was run")
  return { name, goal, externalProvider: input.externalProvider, externalUrl: optionalUrl(input.externalUrl, "Study link") }
}

export type ParsedTurn = { role: "INTERVIEWER" | "PARTICIPANT"; content: string }

// Only well-known labels are treated as speakers. Accepting any "Word:" would split
// participant sentences like "The problem is: it is slow" into bogus turns.
const INTERVIEWER_LABEL = /^(?:interviewer|moderator|researcher|facilitator|host)$/i
const PARTICIPANT_LABEL = /^(?:participant|interviewee|respondent|user|customer|tester|speaker\s*\d*|p\s*\d+)$/i
const LABEL_LINE = /^\s*(?:\[?\d{1,2}:\d{2}(?::\d{2})?\]?\s*[-–]?\s*)?([A-Za-z][A-Za-z ]{0,20}?\d*)\s*:\s*(.*)$/

function splitLongTurn(content: string): string[] {
  if (content.length <= MAX_TURN_CHARS) return [content]
  const pieces: string[] = []
  let rest = content
  while (rest.length > MAX_TURN_CHARS) {
    const window = rest.slice(0, MAX_TURN_CHARS)
    const breakAt = Math.max(window.lastIndexOf("\n"), window.lastIndexOf(" "))
    const cut = breakAt > MAX_TURN_CHARS / 2 ? breakAt : MAX_TURN_CHARS
    pieces.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  if (rest) pieces.push(rest)
  return pieces.filter(Boolean)
}

/**
 * Turns pasted transcript text into ordered turns. Lines prefixed with a known
 * speaker label start a turn; other lines continue the current one. With no labels
 * at all, each blank-line separated paragraph is a participant turn. Turn text is
 * stored verbatim (label and timestamp removed) so analysis quotes stay exact
 * substrings of what is saved.
 */
export function parseExternalTranscript(text: string): ParsedTurn[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n")
  const turns: ParsedTurn[] = []
  let current: ParsedTurn | null = null
  let sawLabel = false
  for (const line of lines) {
    const match = LABEL_LINE.exec(line)
    const label = match?.[1]?.trim()
    const role = label && INTERVIEWER_LABEL.test(label) ? "INTERVIEWER" : label && PARTICIPANT_LABEL.test(label) ? "PARTICIPANT" : null
    if (match && role) {
      sawLabel = true
      current = { role, content: match[2].trim() }
      turns.push(current)
    } else if (!line.trim()) {
      if (!sawLabel) current = null
    } else if (current) {
      current.content = current.content ? `${current.content}\n${line.trim()}` : line.trim()
    } else {
      current = { role: "PARTICIPANT", content: line.trim() }
      turns.push(current)
    }
  }
  return turns.flatMap((turn) => splitLongTurn(turn.content.trim()).map((content) => ({ role: turn.role, content }))).filter((turn) => turn.content)
}

export type ExternalSessionInput = {
  participantName: string | null
  participantEmail: string | null
  externalUrl: string | null
  notes: string | null
  turns: ParsedTurn[]
  sessionDate: Date
  idempotencyKey: string
}

export function normalizeExternalSessionInput(input: {
  participantName?: unknown; participantEmail?: unknown; externalUrl?: unknown; transcript?: unknown
  notes?: unknown; sessionDate?: unknown; idempotencyKey?: unknown
}): ExternalSessionInput {
  const idempotencyKey = String(input.idempotencyKey ?? "")
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(idempotencyKey)) throw new ExternalResearchInputError("A valid idempotency key is required")
  const transcript = String(input.transcript ?? "").trim()
  const notes = String(input.notes ?? "").trim()
  if (!transcript && !notes) throw new ExternalResearchInputError("Add a transcript or notes for this session")
  if (transcript.length > MAX_EXTERNAL_TRANSCRIPT_CHARS) throw new ExternalResearchInputError(`Transcript must be ${MAX_EXTERNAL_TRANSCRIPT_CHARS.toLocaleString("en-US")} characters or fewer`)
  if (notes.length > MAX_EXTERNAL_NOTES_CHARS) throw new ExternalResearchInputError(`Notes must be ${MAX_EXTERNAL_NOTES_CHARS.toLocaleString("en-US")} characters or fewer`)
  const participantName = String(input.participantName ?? "").trim() || null
  if (participantName && participantName.length > 255) throw new ExternalResearchInputError("Participant name must be 255 characters or fewer")
  const email = String(input.participantEmail ?? "").trim().toLowerCase()
  if (email && (email.length > 255 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) throw new ExternalResearchInputError("Enter a valid participant email or leave it blank")
  const turns = parseExternalTranscript(transcript)
  if (turns.length > MAX_EXTERNAL_TURNS) throw new ExternalResearchInputError(`A transcript can have at most ${MAX_EXTERNAL_TURNS} turns`)
  const rawDate = String(input.sessionDate ?? "").trim()
  let sessionDate = new Date()
  if (rawDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) throw new ExternalResearchInputError("Enter the session date as YYYY-MM-DD")
    sessionDate = new Date(`${rawDate}T00:00:00.000Z`)
    if (Number.isNaN(sessionDate.getTime()) || sessionDate.toISOString().slice(0, 10) !== rawDate) throw new ExternalResearchInputError("Enter a valid session date")
    if (sessionDate.getTime() > Date.now() + 24 * 60 * 60 * 1000) throw new ExternalResearchInputError("The session date cannot be in the future")
  }
  return {
    participantName, participantEmail: email || null, externalUrl: optionalUrl(input.externalUrl, "Session link"),
    notes: notes || null, turns, sessionDate, idempotencyKey,
  }
}

/**
 * Session id derived from (study, idempotency key): a retried or double-submitted
 * form resolves to the same primary key, so the primary key is the idempotency
 * fence and no extra column or index is needed. Formatted as a version-5 UUID.
 */
export function deterministicExternalSessionId(studyId: string, idempotencyKey: string): string {
  const hex = createHash("sha256").update(`compass:external-research-session:v1\n${studyId}\n${idempotencyKey}`).digest("hex")
  const variant = ((parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, "0")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(18, 20)}-${hex.slice(20, 32)}`
}
