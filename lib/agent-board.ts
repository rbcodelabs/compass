/**
 * The agent board's bucketing, filtering, squad grouping, and live patch reduction,
 * ported from Geode's kanban (`bucketize()` and `classifyThreadRow()`): which column a
 * conversation lands in, how columns are ordered, and which are shown.
 * Pure and import-safe from client components.
 *
 * A conversation's column comes from its LATEST run, interactive controls, plus a per-user "reviewed" instant:
 *
 *   Working   latest run QUEUED / RUNNING (unless paused on AskUserQuestion)
 *   Awaiting  pending AskUserQuestion item(s) or RUNNING with substatus AWAITING_QUESTION
 *   Waiting   idle with a pending ScheduleWakeup timer
 *   Failed    latest run FAILED / INTERRUPTED (without pending questions; a new turn clears it)
 *   New       idle, has messages, and not reviewed since its last activity
 *   Done      idle, has messages, reviewed at or after its last activity
 *   Ready     no messages yet
 *
 * "Reviewed since last activity" is a timestamp comparison rather than a boolean, so a
 * new assistant message or run after review makes the card New again with no write.
 */

import { formatPrBadge } from "@/lib/agent-card-derive"

export type BoardColumnId = "working" | "awaiting" | "waiting" | "failed" | "new" | "done" | "ready"
export type BoardGroupBy = "status" | "squad"

export const BOARD_COLUMN_LABELS: Record<BoardColumnId, string> = {
  working: "Working",
  awaiting: "Awaiting",
  waiting: "Waiting",
  new: "New",
  done: "Done",
  failed: "Failed",
  ready: "Ready",
}

/** Geode's order: in-flight and interactive controls first, then what needs a look, then settled, then failures. */
export const BOARD_COLUMN_ORDER: readonly BoardColumnId[] = [
  "working",
  "awaiting",
  "waiting",
  "new",
  "done",
  "failed",
  "ready",
]

/** Shown even when empty, so the board never reads as broken. Every other empty column is hidden. */
const ALWAYS_SHOWN: ReadonlySet<BoardColumnId> = new Set(["working", "new"])

/**
 * 3× the 15s worker heartbeat interval (`AGENT_RUN_HEARTBEAT_MS`).
 * Softer than the 90s sweeper timeout: pauses the card spinner as an early visual cue
 * without prematurely failing a run that only had one slow flush.
 */
export const STALE_HEARTBEAT_MS = 45_000

export const MAX_CARD_SUBTASK_ITEMS = 5
export const MAX_CARD_LINKED_OBJECTS = 3
export const UNASSIGNED_SQUAD_COLUMN_ID = "unassigned"

export type AgentBoardCardSquad = {
  id: string
  name: string
  color: string
}

export type AgentBoardCardSubtask = {
  id: string
  title: string
  status: "pending" | "in_progress" | "completed"
}

export type AgentBoardCardSubtasks = {
  completed: number
  total: number
  items: AgentBoardCardSubtask[]
}

export type AgentBoardCardLinkedObject = {
  entityType: "OPPORTUNITY" | "SOLUTION" | "TASK"
  entityId: string
  title: string
  kind: "CREATED" | "MENTIONS"
}

export type AgentBoardCardChildAgents = {
  total: number
  active: number
  failed: number
  roles: string[]
}

export type AgentBoardCardQuestionOption = {
  label: string
  description?: string
}

export type AgentBoardCardPendingQuestion = {
  id: string
  conversationId?: string
  runId: string | null
  header: string | null
  question: string
  options: AgentBoardCardQuestionOption[]
  multiSelect: boolean
  allowOther: boolean
  status: "PENDING" | "ANSWERED" | "CLEARED" | "EXPIRED"
  answerText: string | null
  createdAt: string
}

export type AgentBoardCardScheduledWakeup = {
  id: string
  conversationId?: string
  fireAt: string
  delaySeconds: number
  reason: string | null
  prompt: string
  status?: "PENDING" | "FIRED" | "CANCELED" | "FAILED"
  createdAt?: string
}

/** One conversation as the board sees it. Timestamps are ISO strings so it serializes to the client. */
export type AgentBoardCard = {
  id: string
  title: string | null
  messageCount: number
  /** Status of the most recent run, or null if it never ran. */
  runStatus: string | null
  /** Latest of the conversation's `updatedAt` and its latest run's status change. */
  lastActivityAt: string
  /** When THIS user last reviewed it, or null. Never another participant's. */
  reviewedAt: string | null
  /** Optional owning Squad for Squad grouping and badge display. */
  squad?: AgentBoardCardSquad | null
  /** 1-line markdown-stripped outcome excerpt for idle cards. */
  summary?: string | null
  /** Latest GitHub pull-request URL surfaced in the conversation. */
  prUrl?: string | null
  /** Interactive sub-state while RUNNING (e.g. AWAITING_QUESTION). */
  substatus?: string | null
  /** Latest humanized tool/subagent step while RUNNING. */
  currentActivity?: string | null
  /** ISO timestamp of the latest worker heartbeat on the active run. */
  lastHeartbeatAt?: string | null
  /** Plan tasks created in this conversation via TaskCreate. */
  subtasks?: AgentBoardCardSubtasks
  /** Up to MAX_CARD_LINKED_OBJECTS linked Opportunities, Solutions, or non-plan Tasks. */
  linkedObjects?: AgentBoardCardLinkedObject[]
  /** Total linked object count (may exceed `linkedObjects.length`). */
  linkedObjectCount?: number
  /** Summary of harness-native child sub-agents spawned across this conversation's runs. */
  childAgents?: AgentBoardCardChildAgents
  /** Pending human-in-the-loop AskUserQuestion prompts awaiting an answer. */
  pendingQuestions?: AgentBoardCardPendingQuestion[]
  /** Active durable ScheduleWakeup timer while the conversation waits between turns. */
  scheduledWakeup?: AgentBoardCardScheduledWakeup | null
}

export type AgentBoardColumn = { id: BoardColumnId; label: string; cards: AgentBoardCard[] }

export type SquadBoardColumn = {
  id: string
  label: string
  color: string | null
  cards: AgentBoardCard[]
}

function time(iso: string | null | undefined): number {
  if (!iso) return Number.NaN
  return Date.parse(iso)
}

export function classifyBoardCard(
  card: Pick<
    AgentBoardCard,
    | "runStatus"
    | "substatus"
    | "pendingQuestions"
    | "scheduledWakeup"
    | "messageCount"
    | "lastActivityAt"
    | "reviewedAt"
  >,
): BoardColumnId {
  if ((card.pendingQuestions?.length ?? 0) > 0 || (card.runStatus === "RUNNING" && card.substatus === "AWAITING_QUESTION")) {
    return "awaiting"
  }
  if (card.runStatus === "QUEUED" || card.runStatus === "RUNNING") return "working"
  if (card.scheduledWakeup) return "waiting"
  if (card.runStatus === "FAILED" || card.runStatus === "INTERRUPTED") return "failed"
  if (card.messageCount <= 0) return "ready"
  const reviewed = time(card.reviewedAt)
  const activity = time(card.lastActivityAt)
  // NaN compares false, so a garbled timestamp reads as unreviewed: surfacing a card is the safe failure.
  return reviewed >= activity ? "done" : "new"
}

/** True when a RUNNING card's worker has not sent a heartbeat within STALE_HEARTBEAT_MS. */
export function isRunHeartbeatStale(
  card: Pick<AgentBoardCard, "runStatus" | "lastHeartbeatAt">,
  now: number = Date.now(),
): boolean {
  if (card.runStatus !== "RUNNING" || !card.lastHeartbeatAt) return false
  const beat = time(card.lastHeartbeatAt)
  if (Number.isNaN(beat)) return false
  return now - beat > STALE_HEARTBEAT_MS
}

export function bucketizeBoard(cards: readonly AgentBoardCard[]): AgentBoardColumn[] {
  const buckets = new Map<BoardColumnId, AgentBoardCard[]>(BOARD_COLUMN_ORDER.map((id) => [id, []]))
  for (const card of cards) buckets.get(classifyBoardCard(card))!.push(card)

  return BOARD_COLUMN_ORDER.flatMap((id) => {
    const bucket = buckets.get(id)!
    if (bucket.length === 0 && !ALWAYS_SHOWN.has(id)) return []
    const sorted = [...bucket].sort((a, b) => time(b.lastActivityAt) - time(a.lastActivityAt))
    return [{ id, label: BOARD_COLUMN_LABELS[id], cards: sorted }]
  })
}

/**
 * Groups board cards into Squad columns (ordered by workspace squad order, then alphabetical fallback)
 * followed by an "Unassigned" column when unassigned cards exist (or when the board is completely empty).
 */
export function bucketizeBoardBySquad(
  cards: readonly AgentBoardCard[],
  workspaceSquads: readonly AgentBoardCardSquad[] = [],
): SquadBoardColumn[] {
  const squadMeta = new Map<string, AgentBoardCardSquad>()
  for (const squad of workspaceSquads) squadMeta.set(squad.id, squad)
  for (const card of cards) {
    if (card.squad && !squadMeta.has(card.squad.id)) squadMeta.set(card.squad.id, card.squad)
  }

  const buckets = new Map<string, AgentBoardCard[]>()
  for (const id of squadMeta.keys()) buckets.set(id, [])
  const unassigned: AgentBoardCard[] = []

  for (const card of cards) {
    if (card.squad && buckets.has(card.squad.id)) {
      buckets.get(card.squad.id)!.push(card)
    } else {
      unassigned.push(card)
    }
  }

  const sortByActivity = (list: readonly AgentBoardCard[]) =>
    [...list].sort((a, b) => time(b.lastActivityAt) - time(a.lastActivityAt))

  const columns: SquadBoardColumn[] = []
  for (const [id, squad] of squadMeta) {
    const squadCards = buckets.get(id) ?? []
    // Show every known workspace squad (or any squad holding a card) so Squad view reads as a stable roster.
    if (squadCards.length > 0 || workspaceSquads.some((ws) => ws.id === id)) {
      columns.push({ id, label: squad.name, color: squad.color, cards: sortByActivity(squadCards) })
    }
  }

  if (unassigned.length > 0 || columns.length === 0) {
    columns.push({
      id: UNASSIGNED_SQUAD_COLUMN_ID,
      label: "No squad",
      color: null,
      cards: sortByActivity(unassigned),
    })
  }

  return columns
}

function matchesSearchText(haystack: string | null | undefined, needle: string): boolean {
  return typeof haystack === "string" && haystack.toLowerCase().includes(needle)
}

function matchesPrUrl(prUrl: string | null | undefined, needle: string): boolean {
  if (matchesSearchText(prUrl, needle)) return true
  const badge = formatPrBadge(prUrl)
  if (!badge) return false
  return matchesSearchText(badge.label, needle) || matchesSearchText(badge.repo, needle)
}

/** Case-insensitive client search across card title, summary, live activity, squad, PR URL/badge, subtasks, linked objects, and child-agent roles. */
export function filterBoardCards(cards: readonly AgentBoardCard[], query: string): AgentBoardCard[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return [...cards]
  return cards.filter((card) => {
    if (matchesSearchText(card.title, needle)) return true
    if (matchesSearchText(card.summary, needle)) return true
    if (matchesSearchText(card.currentActivity, needle)) return true
    if (matchesSearchText(card.squad?.name, needle)) return true
    if (matchesPrUrl(card.prUrl, needle)) return true
    if (card.subtasks?.items.some((item) => matchesSearchText(item.title, needle))) return true
    if (card.linkedObjects?.some((obj) => matchesSearchText(obj.title, needle) || matchesSearchText(obj.entityType, needle))) return true
    if (card.childAgents?.roles.some((role) => matchesSearchText(role, needle))) return true
    if (card.pendingQuestions?.some((q) => matchesSearchText(q.header, needle) || matchesSearchText(q.question, needle))) return true
    if (matchesSearchText(card.scheduledWakeup?.reason, needle) || matchesSearchText(card.scheduledWakeup?.prompt, needle)) return true
    return false
  })
}

/** Geode's `relativeTime`: coarse on purpose, a board does not need seconds. */
export function formatRelativeTime(iso: string, now: number = Date.now()): string {
  const diff = Math.max(0, now - Date.parse(iso))
  if (diff < 60_000) return "just now"
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}

/** Compact countdown label for `ScheduleWakeup` pills on Board cards and Chat banners. */
export function formatWakeupCountdown(fireAtIso: string, now: number = Date.now()): string {
  const remainingMs = Date.parse(fireAtIso) - now
  if (Number.isNaN(remainingMs) || remainingMs <= 0) return "due now"
  if (remainingMs < 60_000) return "<1m"
  const totalMinutes = Math.ceil(remainingMs / 60_000)
  if (totalMinutes < 60) return `${totalMinutes}m`
  const hours = Math.floor(totalMinutes / 60)
  const mins = totalMinutes % 60
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`
}

/** Chat-list row: a conversation plus the optional status and rich preview fields the board derives. */
export type AgentListConversation = {
  id: string
  title: string | null
  messageCount?: number
  runStatus?: string | null
  lastActivityAt?: string
  reviewedAt?: string | null
  squad?: AgentBoardCardSquad | null
  summary?: string | null
  prUrl?: string | null
  substatus?: string | null
  currentActivity?: string | null
  lastHeartbeatAt?: string | null
  subtasks?: AgentBoardCardSubtasks
  childAgents?: AgentBoardCardChildAgents
  pendingQuestions?: AgentBoardCardPendingQuestion[]
  scheduledWakeup?: AgentBoardCardScheduledWakeup | null
}

export type AgentListGroup = { id: BoardColumnId; label: string; items: (AgentListConversation & { lastActivityAt: string })[] }
export type AgentListSquadGroup = { id: string; label: string; color: string | null; items: (AgentListConversation & { lastActivityAt: string })[] }

/** Filters chat-list rows using the same rich fields as `filterBoardCards`. */
export function filterListConversations<T extends AgentListConversation>(conversations: readonly T[], query: string): T[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return [...conversations]
  return conversations.filter((c) => {
    if (matchesSearchText(c.title, needle)) return true
    if (matchesSearchText(c.summary, needle)) return true
    if (matchesSearchText(c.currentActivity, needle)) return true
    if (matchesSearchText(c.squad?.name, needle)) return true
    if (matchesPrUrl(c.prUrl, needle)) return true
    if (c.subtasks?.items.some((item) => matchesSearchText(item.title, needle))) return true
    if (c.childAgents?.roles.some((role) => matchesSearchText(role, needle))) return true
    if (c.pendingQuestions?.some((q) => matchesSearchText(q.header, needle) || matchesSearchText(q.question, needle))) return true
    if (matchesSearchText(c.scheduledWakeup?.reason, needle) || matchesSearchText(c.scheduledWakeup?.prompt, needle)) return true
    return false
  })
}

/**
 * Groups the chat list by status (same buckets as the board) and sorts each group by last activity, newest
 * first. Returns null when the rows carry no status data (the rail list), so callers fall back to a flat list.
 */
export function groupConversationsByStatus(conversations: readonly AgentListConversation[]): AgentListGroup[] | null {
  if (conversations.length === 0 || conversations.some((c) => !c.lastActivityAt)) return null
  const byId = new Map(conversations.map((c) => [c.id, c as AgentListConversation & { lastActivityAt: string }]))
  const columns = bucketizeBoard(
    conversations.map((c) => ({
      id: c.id,
      title: c.title,
      messageCount: c.messageCount ?? 1,
      runStatus: c.runStatus ?? null,
      substatus: c.substatus ?? null,
      pendingQuestions: c.pendingQuestions,
      scheduledWakeup: c.scheduledWakeup ?? null,
      lastActivityAt: c.lastActivityAt!,
      reviewedAt: c.reviewedAt ?? null,
    }))
  )
  return columns.filter((col) => col.cards.length > 0).map((col) => ({ id: col.id, label: col.label, items: col.cards.map((card) => byId.get(card.id)!) }))
}

/** Groups the chat list by Squad (with a trailing "No squad" section) when status timestamps are present. */
export function groupConversationsBySquad(
  conversations: readonly AgentListConversation[],
  workspaceSquads: readonly AgentBoardCardSquad[] = [],
): AgentListSquadGroup[] | null {
  if (conversations.length === 0 || conversations.some((c) => !c.lastActivityAt)) return null
  const byId = new Map(conversations.map((c) => [c.id, c as AgentListConversation & { lastActivityAt: string }]))
  const columns = bucketizeBoardBySquad(
    conversations.map((c) => ({
      id: c.id,
      title: c.title,
      messageCount: c.messageCount ?? 1,
      runStatus: c.runStatus ?? null,
      lastActivityAt: c.lastActivityAt!,
      reviewedAt: c.reviewedAt ?? null,
      squad: c.squad ?? null,
    })),
    workspaceSquads,
  )
  return columns
    .filter((col) => col.cards.length > 0)
    .map((col) => ({
      id: col.id,
      label: col.label,
      color: col.color,
      items: col.cards.map((card) => byId.get(card.id)!),
    }))
}

// ── Live Board SSE Diff & Patch Reducer ─────────────────────────────────────

export type AgentBoardSnapshotEvent = {
  cards: AgentBoardCard[]
  cursor: string
}

export type AgentBoardPatchEvent = {
  upserts: AgentBoardCard[]
  removedIds: string[]
  cursor: string
}

/** Computes changed (`upserts`) and deleted (`removedIds`) cards against previous serialized fingerprints. */
export function diffAgentBoardCards(
  previousFingerprints: ReadonlyMap<string, string>,
  nextCards: readonly AgentBoardCard[],
): { nextFingerprints: Map<string, string>; upserts: AgentBoardCard[]; removedIds: string[] } {
  const nextFingerprints = new Map<string, string>()
  const upserts: AgentBoardCard[] = []

  for (const card of nextCards) {
    const serialized = JSON.stringify(card)
    nextFingerprints.set(card.id, serialized)
    if (previousFingerprints.get(card.id) !== serialized) {
      upserts.push(card)
    }
  }

  const removedIds: string[] = []
  for (const id of previousFingerprints.keys()) {
    if (!nextFingerprints.has(id)) removedIds.push(id)
  }

  return { nextFingerprints, upserts, removedIds }
}

/**
 * Applies a live SSE patch while preserving `===` object references for every untouched card,
 * avoiding full-board React re-renders when a single running thread updates its activity line.
 */
export function applyAgentBoardPatch(
  current: readonly AgentBoardCard[],
  patch: Pick<AgentBoardPatchEvent, "upserts" | "removedIds">,
): AgentBoardCard[] {
  if (patch.upserts.length === 0 && patch.removedIds.length === 0) return current as AgentBoardCard[]

  const upsertById = new Map(patch.upserts.map((card) => [card.id, card]))
  const removed = new Set(patch.removedIds)
  const seen = new Set<string>()
  const next: AgentBoardCard[] = []

  for (const existing of current) {
    if (removed.has(existing.id)) continue
    const updated = upsertById.get(existing.id)
    if (updated) {
      next.push(updated)
      seen.add(existing.id)
    } else {
      next.push(existing)
    }
  }

  for (const card of patch.upserts) {
    if (!seen.has(card.id) && !removed.has(card.id)) {
      next.push(card)
    }
  }

  return next
}
