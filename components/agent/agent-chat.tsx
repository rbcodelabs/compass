"use client"

// Agent chat surface (ADR 0001, Phase 4).
//
// Conversation selection is server-driven via the `?c=<id>` search param (the
// page server-loads that conversation's messages), so this component only owns
// the active thread + composer + live streaming of the current turn.
//
// Two transports, because the server has two paths (see app/api/agent/turn):
//
//   * `202 { runId }` — the turn is a *detached run*. The agent is no longer
//     attached to the POST at all: this component becomes a viewer that tails
//     /api/agent/runs/:runId/stream, can be closed and reopened, and reattaches
//     on mount via /api/agent/conversations/:id/run. Closing the tab no longer
//     abandons the turn, which is the whole point of detached runs.
//   * `text/event-stream` — the pre-migration fallback, where the turn lives and
//     dies with this request exactly as it used to.
//
// Both reduce through lib/agent-run-stream.ts so the two views of one turn cannot
// drift apart.

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { Archive, ArchiveRestore, FileText, Loader2, Sparkles, X as XIcon } from "lucide-react"
import { fetchArchivedConversations, setConversationArchived, type ArchivedConversation } from "@/lib/agent-archive-client"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { APPROVAL_UPDATE_PREFIX, isApprovalUpdateMessage } from "@/lib/tool-approval/messages"
import { type PlanItem, type SerializedRun, type Subagent, type ToolStep } from "@/lib/agent-run-stream"
import { AgentActivity, PlanCard } from "@/components/agent/agent-activity"
import { LinkedObjectsCard } from "@/components/agent/linked-objects-card"
import type { ConversationObjectLink } from "@/lib/links/conversation-links"
import { useAgentTurn } from "@/components/agent/use-agent-turn"
import { useAgentChoices } from "@/components/agent/use-agent-choices"
import { ToolsMenu, connectorsEnabledFor } from "@/components/agent/tools-menu"
import { ModelPicker, modelLabelFor, useModelPick } from "@/components/agent/model-picker"
import { AgentChip } from "@/components/agent/composer/agent-chip"
import { ComposerCard } from "@/components/agent/composer/composer-card"
import { AGENT_MAX_GOOGLE_RESOURCES_PER_TURN, GOOGLE_DRIVE_CONNECTOR_SLUG, googleResourcesFromPaste, type GoogleResourceRef } from "@/lib/agent-google-resources"
import { Markdown } from "@/components/agent/markdown"
import { RecentMentions } from "@/components/agent/recent-mentions"
import { AttachMenu, uploadAgentFiles, type AttachedItem, type AttachedUpload } from "@/components/agent/composer/attach-menu"
import { SeedContextChip } from "@/components/agent/seed-context-chip"
import { AgentParticipantsPanel, type Roster } from "@/components/agent/agent-participants"
import { initialsOf } from "@/lib/user-initials"
import { formatRelativeTime, groupConversationsByStatus, type AgentListConversation, type BoardColumnId } from "@/lib/agent-board"
import { cn } from "@/lib/utils"

type Role = "user" | "assistant"
type Message = {
  id: string
  role: Role
  content: string
  toolCalls?: ToolStep[]
  plan?: PlanItem[]
  subagents?: Subagent[]
  /** ISO instant. Present on messages the server has stored; the polling cursor. */
  createdAt?: string
  /** Who sent a user message. Absent on a message this tab has only optimistically shown. */
  authorUserId?: string | null
  authorName?: string | null
}
type ConversationSummary = AgentListConversation
type SeedEntity = { entityType: string; entityId: string; label: string; summary: string; sourceUrl: string }

type Props = {
  workspaceId: string
  basePath: string // `/${orgSlug}/${workspaceSlug}`
  conversations: ConversationSummary[]
  activeConversationId: string | null
  initialMessages: Message[]
  userInitials: string
  /** The signed-in user, to tell their messages from other participants'. */
  userId: string
  /** "Send to agent" hand-off (lib/agent-context.ts) — only ever set for a brand-new chat. */
  seedEntity?: SeedEntity
  suggestedInstruction?: string
  /**
   * "Ask the agent about this" from the rail's Docs tab. Applied once per `id`:
   * shows a display-only context chip and prefills the composer (appending to
   * any draft). Never sent automatically, and never forwarded as `seedContext`
   * — a docs article is not a Compass entity the server can resolve.
   */
  composerSeed?: { id: number; label?: string; summary?: string; sourceUrl?: string; text: string } | null
  onComposerSeedApplied?: () => void
  /** From `?agentId=` (the Send to agent menu): the agent to start with. Ignored if the member cannot pick it. */
  initialAgentId?: string
  /**
   * Which surface this chat is rendered on.
   *
   * `"page"` (the default, so every existing call site is unchanged) is the
   * full-pane agent screen: it fills whatever its parent gives it and shows a
   * collapsible conversation list as an inline left column.
   *
   * `"rail"` is the docked left rail. It drops both of those: the rail supplies
   * the surrounding chrome itself, and a 320–560px column has no room for a
   * 256px conversation list beside the thread — so the rail hosts the
   * new-chat/thread-switcher controls in its own header and this component
   * renders the thread and composer only.
   */
  variant?: "page" | "rail"
  /**
   * Whether the page variant's conversation list is shown. Controlled by the
   * page shell, which owns the toggle in its title bar (and the cookie behind
   * it); ignored by the rail, which has no inline list.
   */
  listOpen?: boolean
  /** Conversations the shell has marked read this session (after its dwell), overriding the server-rendered status. */
  reviewedIds?: ReadonlySet<string>
  /**
   * Called when turn 1 of a brand-new chat comes back with the id the server
   * assigned to it.
   *
   * The page does not need this: it learns the id from the `?c=<id>` it rewrites
   * the URL to. The rail has no URL to read — it owns the active thread in React
   * state — so this callback is the only way it finds out which conversation the
   * transcript on screen now belongs to. Without it, the next "new chat" click
   * would be indistinguishable from the current one and "expand to full page"
   * would open an empty thread.
   */
  onConversationCreated?: (conversationId: string) => void
  /**
   * Called whenever a turn starts or stops streaming.
   *
   * The rail needs it because closing the rail unmounts this component, which
   * aborts the turn: it uses it to keep Esc and "expand to full page" from
   * doing that implicitly mid-turn. The page does not pass it.
   */
  onStreamingChange?: (streaming: boolean) => void
}

type Processing = {
  status: "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "INTERRUPTED"
  /** Absent from an older server response, which only ever meant PM_INTERVIEW. */
  kind?: "PM_INTERVIEW" | "RESEARCH_SYNTHESIS"
  interviewId?: string
  targetUrl?: string | null
  canContinue?: boolean
  receipt: { changedFields: string[]; targetUrl: string; before?: Record<string, unknown>; after?: Record<string, unknown> } | null
}

/** Ids this tab invents for messages the server has not reported back yet. */
const isLocalMessageId = (id: string) => /^(local|run|a)-/.test(id)

/** How often a shared conversation asks the server what others have said. No push in v1. */
const SHARED_POLL_MS = 4_000

export function AgentChat({
  workspaceId,
  basePath,
  conversations,
  activeConversationId,
  initialMessages,
  userInitials,
  userId,
  seedEntity,
  suggestedInstruction,
  composerSeed,
  onComposerSeedApplied,
  initialAgentId,
  variant = "page",
  listOpen = true,
  reviewedIds,
  onConversationCreated,
  onStreamingChange,
}: Props) {
  const isRail = variant === "rail"
  const router = useRouter()
  // Archive: the page list shows active chats; "Archived" swaps it for the archived ones.
  const [showArchived, setShowArchived] = useState(false)
  const [archivedChats, setArchivedChats] = useState<ArchivedConversation[]>([])
  const toggleArchivedList = useCallback(async () => {
    if (!showArchived) setArchivedChats(await fetchArchivedConversations(workspaceId))
    setShowArchived((v) => !v)
  }, [showArchived, workspaceId])
  const changeArchived = useCallback(
    async (id: string, archived: boolean) => {
      if (!(await setConversationArchived(workspaceId, id, archived))) return
      if (archived && id === activeConversationId) router.push(`${basePath}/agent`)
      if (!archived) setArchivedChats((list) => list.filter((c) => c.id !== id))
      router.refresh()
    },
    [workspaceId, activeConversationId, basePath, router],
  )
  const [messages, setMessages] = useState<Message[]>(initialMessages)
  // Prefilled (editable) composer instruction from a "Send to agent" hand-off
  // — only for a brand-new chat. Lazy initializer so this never overwrites
  // composer text when resuming a past conversation (activeConversationId set).
  const [input, setInput] = useState(() => (!activeConversationId ? (suggestedInstruction ?? "") : ""))
  // The hand-off's context chip. Cleared on dismiss (composer text untouched)
  // and cleared the moment its seedContext is sent on the first turn, so it's
  // never resent — belt-and-suspenders alongside the server's own
  // conversationId-presence guard (app/api/agent/turn/route.ts).
  const [pendingSeedEntity, setPendingSeedEntity] = useState<SeedEntity | undefined>(seedEntity)
  const [attachedItems, setAttachedItems] = useState<AttachedItem[]>([])
  const [attachedUploads, setAttachedUploads] = useState<AttachedUpload[]>([])
  const [attachError, setAttachError] = useState<string | null>(null)
  const [googleResources, setGoogleResources] = useState<GoogleResourceRef[]>([])
  const [dragging, setDragging] = useState(false)
  const dragDepth = useRef(0)
  const [orgSlug, workspaceSlug] = basePath.split("/").filter(Boolean)
  const [docChip, setDocChip] = useState<{ label: string; summary: string; sourceUrl: string } | null>(null)
  const appliedSeedId = useRef<number | null>(null)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const onComposerSeedAppliedRef = useRef(onComposerSeedApplied)
  useEffect(() => {
    onComposerSeedAppliedRef.current = onComposerSeedApplied
  }, [onComposerSeedApplied])
  useEffect(() => {
    if (!composerSeed || appliedSeedId.current === composerSeed.id) return
    appliedSeedId.current = composerSeed.id
    if (composerSeed.label && composerSeed.sourceUrl) {
      setDocChip({ label: composerSeed.label, summary: composerSeed.summary ?? "", sourceUrl: composerSeed.sourceUrl })
    }
    setInput((prev) => (prev.trim() ? `${prev.replace(/\s+$/, "")}\n\n${composerSeed.text}` : composerSeed.text))
    onComposerSeedAppliedRef.current?.()
    requestAnimationFrame(() => composerRef.current?.focus())
  }, [composerSeed])
  // The turn lifecycle (POST, detached-run viewer, inline stream fallback) lives
  // in useAgentTurn so the Cmd+K palette's quick ask runs the very same code.
  // This component only decides what a finished reply does to *its* transcript.
  // Which agent answers: "" follows the resolved default (the server decides), "builtin" is the built-in agent on purpose.
  const agentChoices = useAgentChoices({ workspaceId })
  const [agentPick, setAgentPick] = useState(initialAgentId ?? "")
  const agentSelection = agentPick === "builtin" || agentChoices.agents.some((agent) => agent.id === agentPick) ? agentPick : ""
  const driveConnected = agentChoices.connectors.some((c) => c.slug === GOOGLE_DRIVE_CONNECTOR_SLUG)
  // A paste that is nothing but Drive links becomes chips instead of text; anything else pastes as usual.
  const addGoogleResource = useCallback((ref: GoogleResourceRef) => {
    setGoogleResources((list) => (list.some((r) => r.fileId === ref.fileId) ? list : [...list, ref].slice(0, AGENT_MAX_GOOGLE_RESOURCES_PER_TURN)))
  }, [])
  const pasteGoogleLinks = useCallback((text: string): boolean => {
    const refs = googleResourcesFromPaste(text)
    if (!refs.length) return false
    setGoogleResources((list) => {
      const known = new Set(list.map((r) => r.fileId))
      return [...list, ...refs.filter((r) => !known.has(r.fileId))].slice(0, AGENT_MAX_GOOGLE_RESOURCES_PER_TURN)
    })
    return true
  }, [])
  const defaultAgentName = agentChoices.agents.find((agent) => agent.id === agentChoices.defaultAgentId)?.name ?? "Compass Agent"
  const modelPick = useModelPick({ userId, workspaceId, choices: agentChoices, agentSelection })
  const turn = useAgentTurn({
    workspaceId,
    onConversationCreated: (createdId) => {
      selfCreated.current.add(createdId)
      onConversationCreatedRef.current?.(createdId)
      // Rewrite `?c=` immediately so a reload — or a tab closed now and
      // reopened in an hour — lands on the conversation that owns this run and
      // reattaches to it. `router.refresh()` waits until the turn is done.
      // Page-only: the rail is mounted in the workspace layout, above whichever
      // route the user is on, and `router.replace` from there would navigate
      // them to the agent screen mid-stream — the interruption the rail exists
      // to remove. The rail keeps its list current by refetching (see AgentRail).
      if (!isRail) router.replace(`${basePath}/agent?c=${createdId}`)
    },
    onSettled: ({ assistant, detached }) => {
      if (assistant) {
        setMessages((m) => [...m, { id: assistant.id, role: "assistant", content: assistant.content, toolCalls: assistant.toolCalls, plan: assistant.plan, subagents: assistant.subagents }])
      }
      // In a shared conversation the server also stored this reply under its own id,
      // and other people's turns are in the history too, so take the stored
      // transcript instead of leaving this tab's provisional copy on screen.
      if (detached && sharedRef.current) void reconcileRef.current(true)
      // Deferred to here on purpose: `router.refresh()` re-renders the server
      // component that supplies `initialMessages`, and doing that mid-run would
      // re-seed the transcript out from under the stream the user is reading.
      if (!isRail) router.refresh()
    },
  })
  const { phase, streamingText, liveToolSteps, livePlan, planVersion, liveSubagents, error, setError, suggestion, clearSuggestion, activeRun, isStreaming, cancelRun, attachToRun, abortViewers, reset: resetTurn, sending, start: startTurn } = turn
  const bottomRef = useRef<HTMLDivElement>(null)
  /** Who is in this conversation; null until loaded, or when unavailable. */
  const [roster, setRoster] = useState<Roster | null>(null)
  /** Set once the server says this conversation is no longer ours (left, or removed). */
  const [accessLost, setAccessLost] = useState<"left" | "removed" | null>(null)
  const [processing, setProcessing] = useState<Processing | null>(null)
  const [processingLoading, setProcessingLoading] = useState(Boolean(activeConversationId))
  const started = useRef(new Set<string>())
  // Kept in a ref so a parent passing an inline arrow can't change `send`'s
  // identity on every render — `send` is what the handoff auto-dispatch effect
  // reads through `sendRef`, and churning it there is how you get a double
  // dispatch.
  const onConversationCreatedRef = useRef(onConversationCreated)
  useEffect(() => {
    onConversationCreatedRef.current = onConversationCreated
  }, [onConversationCreated])
  // Conversations *this* component created, awaiting one re-seed skip each. See
  // the re-seed effect below for what that is protecting.
  const selfCreated = useRef(new Set<string>())

  const shared = Boolean(roster?.available && roster.participants.length > 1)
  const sharedRef = useRef(shared)
  useEffect(() => {
    sharedRef.current = shared
  }, [shared])
  const messagesRef = useRef(messages)
  useEffect(() => {
    messagesRef.current = messages
  }, [messages])
  const reconcileRef = useRef<(full?: boolean) => Promise<void>>(async () => {})
  const nameOf = useCallback(
    (id: string | null | undefined) => roster?.participants.find((p) => p.userId === id)?.name ?? null,
    [roster],
  )

  // Through a ref for the same reason as onConversationCreated: an inline arrow
  // from the parent must not re-fire this on every render, only on a change.
  const onStreamingChangeRef = useRef(onStreamingChange)
  useEffect(() => {
    onStreamingChangeRef.current = onStreamingChange
  }, [onStreamingChange])
  useEffect(() => {
    onStreamingChangeRef.current?.(isStreaming)
  }, [isStreaming])
  const composerBlocked = processingLoading || Boolean(processing && (!processing.canContinue || processing.status === "RUNNING" || processing.status === "PENDING"))

  // Set by a thread switch, read once by the scroll effect below. Declared before both effects so the compiler sees it before the first mutation.
  const jumpToBottom = useRef(false)

  // Re-seed the transcript whenever the selected conversation changes — with one
  // exception, consumed exactly once.
  //
  // Turn 1 of a new chat ends with the server's new conversation id being
  // adopted, which changes `activeConversationId` from null to that id. On the
  // page that arrives together with the server-loaded transcript, so re-seeding
  // is a no-op swap of identical content. The rail has no server render to
  // piggyback on: it adopts the id in place and deliberately does *not* refetch
  // messages it already has on screen, so `initialMessages` is still the empty
  // array the chat started with — and re-seeding from it would erase the turn
  // the user just watched stream in.
  //
  // The flag is removed as it is used, which is the part that matters. Leaving
  // it set would mean that switching to another thread and back to this one
  // skipped the re-seed a second time, leaving the *other* thread's messages on
  // screen under this thread's id.
  useEffect(() => {
    if (activeConversationId && selfCreated.current.has(activeConversationId)) {
      selfCreated.current.delete(activeConversationId)
      return
    }
    // A real thread switch: stop reading the previous thread's run. The run keeps
    // going server-side, and coming back to that thread reattaches to it.
    resetTurn()
    setAccessLost(null)
    jumpToBottom.current = true
    setMessages(initialMessages)
  }, [activeConversationId, initialMessages, resetTurn])

  // Loading a different thread replaces the whole transcript, so jump straight
  // to the end instead of animating through every message. Smooth scrolling is
  // kept for incremental updates (new messages, streaming text).
  useEffect(() => {
    const instant = jumpToBottom.current
    jumpToBottom.current = false
    bottomRef.current?.scrollIntoView({ behavior: instant ? "auto" : "smooth", block: "end" })
  }, [messages, streamingText, liveToolSteps, livePlan, liveSubagents, phase])

  // `handoffKind` is passed in rather than read from `processing` because the
  // auto-dispatch below fires from the same tick as its `setProcessing`, so this
  // closure would still see the previous value. Optimistic text only: the server
  // replaces a claimed turn's message with the registered per-kind instruction
  // (lib/agent-handoff-kinds.ts).
  const send = useCallback(async (handoff = false, retry = false, handoffKind?: Processing["kind"], queuedText?: string) => {
    const text = queuedText ?? (handoff
      ? handoffKind === "RESEARCH_SYNTHESIS" ? "Synthesize my saved research for this study." : "Use my saved interview to update the item."
      : input.trim())
    if (!text || sending.current) return
    // A queued message was already cleared from the field; whatever is typed now is the next draft.
    if (queuedText === undefined) setInput("")
    setMessages((m) => [...m, { id: `local-${Date.now()}`, role: "user", content: text }])

    // Only turn 1 of a brand-new conversation carries seedContext — never a
    // resumed thread. Clear it immediately so a second send() in this same
    // session (before the server round-trip updates activeConversationId)
    // can't resend it.
    const seedContextForThisTurn =
      !activeConversationId && pendingSeedEntity
        ? { entityType: pendingSeedEntity.entityType, entityId: pendingSeedEntity.entityId }
        : undefined
    if (seedContextForThisTurn) setPendingSeedEntity(undefined)
    setDocChip(null)
    const contextItemsForThisTurn = attachedItems.map(({ type, id }) => ({ type, id }))
    const uploadsForThisTurn = attachedUploads.map((u) => u.ref)
    const googleLinksForThisTurn = googleResources.map((r) => r.url)
    setGoogleResources([])
    setAttachedItems([])
    setAttachedUploads([])
    setAttachError(null)

    await startTurn({
      message: text,
      contextItems: contextItemsForThisTurn,
      uploads: uploadsForThisTurn,
      googleLinks: googleLinksForThisTurn,
      conversationId: activeConversationId,
      seedContext: seedContextForThisTurn,
      agentId: agentSelection || undefined,
      model: modelPick.model || undefined,
      // The rail floats over whatever page the user is on, so tell the server which one.
      // Read at send time (not from render state) so it is the page NOW, not when the
      // component last rendered. The full-page agent screen has no page behind it.
      pageUrl: isRail ? window.location.pathname + window.location.search : undefined,
      retry,
      continueTurn: !handoff && Boolean(processing?.canContinue),
    })
  }, [input, activeConversationId, isRail, processing?.canContinue, pendingSeedEntity, attachedItems, attachedUploads, googleResources, sending, startTurn, agentSelection, modelPick.model])

  // The agent's plan is its Compass tasks for this conversation (TaskCreate/TaskUpdate), read from the server so it
  // survives a reload and reaches participants. Refetched when a task tool call finishes (planVersion) and when a turn ends.
  const [planState, setPlanState] = useState<{ conversationId: string; plan: PlanItem[] } | null>(null)
  useEffect(() => {
    if (!activeConversationId) return
    const lookup = new AbortController()
    void (async () => {
      try {
        const res = await fetch(`/api/agent/conversations/${activeConversationId}/tasks?workspaceId=${encodeURIComponent(workspaceId)}`, { signal: lookup.signal })
        if (!res.ok) return
        const body = await res.json() as { plan?: PlanItem[] }
        setPlanState({ conversationId: activeConversationId, plan: Array.isArray(body.plan) ? body.plan : [] })
      } catch {
        // Best-effort: the card simply stays as it was.
      }
    })()
    return () => lookup.abort()
  }, [activeConversationId, workspaceId, planVersion, isStreaming])
  const conversationPlan = planState && planState.conversationId === activeConversationId ? planState.plan : []

  // The Opportunities, Solutions and Tasks this conversation created or touched (entity links the agent's tools write automatically).
  // Read from the server so it survives a reload and reaches participants; refetched as tool steps land and when a turn ends.
  const [linkedState, setLinkedState] = useState<{ conversationId: string; items: ConversationObjectLink[] } | null>(null)
  useEffect(() => {
    if (!activeConversationId) return
    const lookup = new AbortController()
    void (async () => {
      try {
        const res = await fetch(`/api/agent/conversations/${activeConversationId}/links?workspaceId=${encodeURIComponent(workspaceId)}`, { signal: lookup.signal })
        if (!res.ok) return
        const body = await res.json() as { items?: ConversationObjectLink[] }
        setLinkedState({ conversationId: activeConversationId, items: Array.isArray(body.items) ? body.items : [] })
      } catch {
        // Best-effort: the card simply stays as it was.
      }
    })()
    return () => lookup.abort()
  }, [activeConversationId, workspaceId, liveToolSteps.length, isStreaming])
  const linkedObjects = linkedState && linkedState.conversationId === activeConversationId ? linkedState.items : []

  // Reattach to a run already in flight for this conversation.
  //
  // This is the payoff for making runs durable: a reopened tab asks the
  // conversation what is running, then replays the event log from seq 0 to rebuild
  // the live view. It is also harmless in the tab that started the run — watchRun's
  // own guard means the second reader is never opened.
  useEffect(() => {
    if (!activeConversationId) return
    let cancelled = false
    const lookup = new AbortController()
    void (async () => {
      try {
        const res = await fetch(
          `/api/agent/conversations/${activeConversationId}/run?workspaceId=${encodeURIComponent(workspaceId)}`,
          { signal: lookup.signal },
        )
        if (cancelled || !res.ok) return
        const body = await res.json() as { run: SerializedRun | null; available: boolean }
        if (cancelled || !body.run || body.run.done) return
        await attachToRun(body.run)
      } catch {
        // Best-effort: failing to reattach leaves a normal, idle chat on screen,
        // and the run carries on regardless.
      }
    })()
    return () => {
      cancelled = true
      lookup.abort()
    }
  }, [activeConversationId, workspaceId, attachToRun])

  // Shared conversations: what other participants say, and the runs
  // they start, arrive by polling. There is no server push in v1, so this is the
  // whole of "live" — a few seconds behind, by design.
  //
  // It only acts while this tab is idle. A tab that is sending or watching a run
  // already has that turn's state in hand, and a poll landing in the middle would
  // race it; the run's end reconciles the transcript instead (see watchRun).
  const reconcile = useCallback(async (full = false) => {
    if (!activeConversationId) return
    const after = full
      ? null
      : messagesRef.current.reduce<string | null>(
          (latest, m) => (m.createdAt && (!latest || m.createdAt > latest) ? m.createdAt : latest),
          null,
        )
    const url = `/api/agent/conversations/${activeConversationId}/messages?workspaceId=${encodeURIComponent(workspaceId)}${
      after ? `&after=${encodeURIComponent(after)}` : ""
    }`
    const res = await fetch(url)
    if (res.status === 404) {
      setAccessLost("removed")
      return
    }
    if (!res.ok) return
    const body = await res.json() as { messages?: Message[] }
    const incoming = (body.messages ?? []).flatMap((m) =>
      m && typeof m.id === "string" && typeof m.content === "string"
        ? [{ ...m, role: m.role === "assistant" ? ("assistant" as const) : ("user" as const) }]
        : [],
    )
    if (!after) {
      // No cursor: this is the whole transcript, so it replaces what is on screen.
      if (incoming.length === 0) return
      setMessages((current) => {
        // The tool steps live only in this tab (the server stores the reply text),
        // so carry them onto the stored copy of the reply they belong to.
        const carried = current.find((m) => m.id.startsWith("run-") && (m.toolCalls?.length || m.plan?.length || m.subagents?.length))
        if (!carried) return incoming
        const lastAssistant = incoming.map((m) => m.role).lastIndexOf("assistant")
        return incoming.map((m, i) =>
          i === lastAssistant && !m.toolCalls && !m.plan && !m.subagents
            ? { ...m, toolCalls: carried.toolCalls, plan: carried.plan, subagents: carried.subagents }
            : m,
        )
      })
      return
    }
    if (incoming.length === 0) return
    setMessages((current) => {
      const known = new Set(current.map((m) => m.id))
      const fresh = incoming.filter((m) => !known.has(m.id))
      if (fresh.length === 0) return current
      // The cursor is inclusive, so the last message comes back every time and is
      // skipped above. A provisional copy of a message the server now reports is
      // dropped rather than shown twice.
      const kept = current.filter(
        (m) => !(isLocalMessageId(m.id) && fresh.some((f) => f.role === m.role && f.content === m.content)),
      )
      return [...kept, ...fresh]
    })
  }, [activeConversationId, workspaceId])
  useEffect(() => {
    reconcileRef.current = (full) => reconcile(full).catch(() => {})
  }, [reconcile])

  useEffect(() => {
    if (!activeConversationId || !shared || accessLost) return
    let cancelled = false
    const tick = async () => {
      if (cancelled || document.visibilityState !== "visible") return
      if (sending.current || phase !== "idle") return
      try {
        // Messages first: the sender's message is stored before its run starts, so
        // when a run is found below its prompt is already on screen.
        await reconcile()
        if (cancelled || sending.current) return
        const res = await fetch(
          `/api/agent/conversations/${activeConversationId}/run?workspaceId=${encodeURIComponent(workspaceId)}`,
        )
        if (cancelled || !res.ok || sending.current) return
        const body = await res.json() as { run: SerializedRun | null }
        if (body.run && !body.run.done) void attachToRun(body.run)
      } catch {
        // A missed tick costs a few seconds; the next one catches up.
      }
    }
    const timer = setInterval(() => void tick(), SHARED_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [activeConversationId, workspaceId, shared, accessLost, phase, reconcile, attachToRun, sending])

  const handleAccessLost = useCallback(
    (reason: "left" | "removed") => {
      abortViewers()
      setAccessLost(reason)
      // Leaving on the full page drops the now-inaccessible thread from the URL.
      if (reason === "left" && !isRail) router.replace(`${basePath}/agent`)
    },
    [isRail, router, basePath, abortViewers],
  )

  const sendRef = useRef(send)
  useEffect(() => { sendRef.current = send }, [send])
  useEffect(() => {
    setProcessing(null)
    setProcessingLoading(Boolean(activeConversationId))
    if (!activeConversationId) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    async function refreshProcessing() {
      try {
        const response = await fetch(`/api/agent/conversations/${activeConversationId}/processing?workspaceId=${encodeURIComponent(workspaceId)}`)
        if (cancelled) return
        if (response.status === 404) { setProcessingLoading(false); return }
        if (!response.ok) throw new Error("Unable to check processing status. Reload before retrying.")
        const state = await response.json() as Processing
        if (cancelled) return
        setProcessing(state)
        setProcessingLoading(false)
        if (state.status === "PENDING" && !started.current.has(activeConversationId!)) {
          started.current.add(activeConversationId!)
          void sendRef.current(true, false, state.kind)
        }
        if (state.status === "PENDING" || state.status === "RUNNING") timer = setTimeout(() => void refreshProcessing(), 2000)
      } catch (caught) {
        if (!cancelled) { setError(caught instanceof Error ? caught.message : "Unable to check processing status."); timer = setTimeout(() => void refreshProcessing(), 5000) }
      }
    }
    void refreshProcessing()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [activeConversationId, workspaceId, phase, setError])

  const phaseLabel = useMemo(() => {
    if (phase === "booting") return "Starting the agent…"
    if (phase === "running" && !streamingText && liveToolSteps.length === 0 && livePlan.length === 0 && liveSubagents.length === 0) return "Thinking…"
    return null
  }, [phase, streamingText, liveToolSteps.length, livePlan.length, liveSubagents.length])

  // Stop is for whoever started the run, and for the owner (enforced server-side too).
  const runStarterId = activeRun?.startedByUserId ?? null
  const runStartedByOther = Boolean(runStarterId && runStarterId !== userId)
  const canCancelRun = !runStartedByOther || roster?.viewerRole === "OWNER"
  const composerDisabled = isStreaming || composerBlocked || Boolean(accessLost)
  // While a turn streams the user can still write a follow-up; it is held here and sent when the turn settles.
  const canQueue = isStreaming && !composerBlocked && !accessLost
  const [queued, setQueued] = useState<string | null>(null)
  const queueFollowUp = () => {
    const text = input.trim()
    if (!text) return
    setQueued((q) => (q ? q + "\n\n" + text : text))
    setInput("")
  }
  const sendRef2 = useRef(send)
  useEffect(() => { sendRef2.current = send }, [send])
  useEffect(() => {
    if (!queued || isStreaming || composerBlocked || accessLost || sending.current) return
    const text = queued
    setQueued(null)
    void sendRef2.current(false, false, undefined, text)
  }, [queued, isStreaming, composerBlocked, accessLost, sending])
  // Who is answering and on what, shown in the composer card while a detached run is live.
  // A chat counts as read only after the shell dwell, so the list follows reviewedIds rather than merely being open.
  const groups = useMemo(
    () =>
      groupConversationsByStatus(
        conversations.map((c) => (reviewedIds?.has(c.id) && c.lastActivityAt ? { ...c, reviewedAt: c.lastActivityAt } : c))
      ),
    [conversations, reviewedIds]
  )
  const runStatusLine =
    activeRun && !activeRun.done
      ? activeRun.agentName
        ? `${activeRun.agentName} is answering${activeRun.model ? ` on ${modelLabelFor(agentChoices, activeRun.model)}` : ""}.`
        : activeRun.model
          ? `Answering on ${modelLabelFor(agentChoices, activeRun.model)}.`
          : null
      : null

  const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files")
  const canDrop = !composerDisabled && !accessLost
  const dropHandlers = {
    onDragEnter: (e: React.DragEvent) => { if (!canDrop || !hasFiles(e)) return; e.preventDefault(); dragDepth.current++; setDragging(true) },
    onDragOver: (e: React.DragEvent) => { if (!canDrop || !hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = "copy" },
    onDragLeave: (e: React.DragEvent) => { if (!hasFiles(e)) return; dragDepth.current = Math.max(0, dragDepth.current - 1); if (dragDepth.current === 0) setDragging(false) },
    onDrop: (e: React.DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      dragDepth.current = 0
      setDragging(false)
      if (!canDrop) return
      setAttachError(null)
      void uploadAgentFiles({ files: Array.from(e.dataTransfer.files), workspaceId, uploadCount: attachedUploads.length, onUploaded: (u) => setAttachedUploads((l) => [...l, u]), onError: setAttachError })
    },
  }

  return (
    <div
      {...dropHandlers}
      // No card chrome in either variant: the page sits under WorkspacePage's
      // header and fills the pane edge to edge, and the rail draws its own
      // border and header.
      className="relative flex min-h-0 flex-1 overflow-hidden bg-surface-panel"
    >
      {dragging && (
        <div data-testid="agent-drop-overlay" className="pointer-events-none absolute inset-2 z-50 grid place-items-center rounded-lg border-2 border-dashed border-primary bg-popover/90 text-sm font-medium text-foreground">
          Drop files to attach them to your message
        </div>
      )}
      {/* Conversation list — page only; in the rail these controls live in the
          rail header instead, because 256px of list plus a readable thread does
          not fit in a 320–560px column. Shown or removed entirely by the page
          shell's title-bar toggle (no residual strip). Below md it is hidden
          outright, as before. */}
      {!isRail && listOpen && (
      <aside className="hidden w-64 shrink-0 flex-col border-r border-default bg-surface-inset md:flex">
        <ScrollArea className="min-h-0 flex-1 p-2">
          <ul className="flex flex-col gap-1">
            {(showArchived ? archivedChats : conversations).length === 0 && (
              <li className="px-2 py-6 text-center text-sm text-text-subtle">
                {showArchived ? "No archived chats" : "No conversations yet"}
              </li>
            )}
            {groups && !showArchived
              ? groups.map((group) => (
                  <li key={group.id} className="flex flex-col gap-1">
                    <p className="flex items-center justify-between px-3 pt-3 text-[11px] font-semibold uppercase tracking-wide text-text-subtle">
                      <span>{group.label}</span>
                      <span>{group.items.length}</span>
                    </p>
                    <ul className="flex flex-col gap-1">
                      {group.items.map((c) => (
                        <ConversationRow
                          key={c.id}
                          c={c}
                          status={group.id}
                          active={c.id === activeConversationId}
                          basePath={basePath}
                          archived={false}
                          onToggleArchived={() => void changeArchived(c.id, true)}
                        />
                      ))}
                    </ul>
                  </li>
                ))
              : (showArchived ? archivedChats : conversations).map((c) => (
                  <ConversationRow
                    key={c.id}
                    c={c}
                    status={null}
                    active={c.id === activeConversationId}
                    basePath={basePath}
                    archived={showArchived}
                    onToggleArchived={() => void changeArchived(c.id, !showArchived)}
                  />
                ))}
          </ul>
        </ScrollArea>
        <div className="border-t border-default p-2">
          <Button variant="ghost" size="sm" className="w-full justify-start" onClick={() => void toggleArchivedList()}>
            {showArchived ? "Back to chats" : "Archived chats"}
          </Button>
        </div>
      </aside>
      )}

      {/* Thread + composer.
          min-w-0 is load-bearing: as a flex item this column defaults to
          min-width:auto, so it refuses to shrink below its content's
          min-content width. The seed context chip's summary line is
          `truncate` (white-space:nowrap), whose min-content width is the
          full untruncated string — that propagated up and inflated this
          column past the viewport inside the overflow-hidden root, pushing
          the Send button and the chip's own dismiss control off-screen on
          any width below ~1000px. */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {activeConversationId && !accessLost && (
          <AgentParticipantsPanel
            conversationId={activeConversationId}
            workspaceId={workspaceId}
            userId={userId}
            compact={isRail}
            onRoster={setRoster}
            onAccessLost={handleAccessLost}
          />
        )}
        <ScrollArea className="min-h-0 flex-1">
          {/* `sm:p-6` is dropped in the rail: the breakpoint tracks the
              viewport, not this column, so a 360px rail on a wide screen would
              otherwise spend 48px of its width on padding. */}
          <div className={`mx-auto flex w-full max-w-3xl flex-col gap-4 ${isRail ? "p-3" : "p-4 sm:p-6"}`}>
            {processing && (processing.kind === "RESEARCH_SYNTHESIS"
              // ADR-0012 step 4. This handoff has no target item and no field
              // receipt — its durable artifact is the ResearchSynthesis snapshot
              // on the study page, so the PM panel's copy and links do not apply.
              ? <section aria-live="polite" className="space-y-2 rounded-lg border p-4 text-sm">
                {/* "Turn finished" rather than "Synthesis stored": the claim is
                    marked SUCCEEDED whenever the turn completes without throwing,
                    which does not by itself prove the agent called the storage
                    tool or that its citations passed validation. The study page
                    is the authority on whether a snapshot exists. */}
                <p className="font-medium">{processing.status === "SUCCEEDED" ? "Synthesis turn finished" : processing.status === "RUNNING" || processing.status === "PENDING" ? "Synthesizing your saved research…" : "The synthesis did not finish"}</p>
                <p>Your saved research is unchanged. {processing.status === "SUCCEEDED" ? "Check the study page for the stored snapshot, and read the agent’s reply above for what it found." : "Follow the agent’s progress here."}</p>
                {processing.targetUrl && <Link className="block underline" href={processing.targetUrl}>View study and synthesis history</Link>}
                {(processing.status === "FAILED" || processing.status === "INTERRUPTED") && <Button disabled={isStreaming} onClick={() => void send(true, true, processing.kind)}>Retry synthesis</Button>}
              </section>
              : <section aria-live="polite" className="space-y-2 rounded-lg border p-4 text-sm">
                <p className="font-medium">{processing.receipt ? (processing.receipt.changedFields.length ? "Item updated" : "No changes saved") : processing.status === "RUNNING" || processing.status === "PENDING" ? "Updating your item…" : "The update did not finish"}</p>
                {processing.receipt ? <><dl className="space-y-3">{processing.receipt.changedFields.map(field => <div key={field}><dt className="font-medium">{field}</dt>{processing.receipt?.before && processing.receipt?.after && <dd className="grid gap-2 sm:grid-cols-2"><div><span className="text-text-subtle">Before</span><p className="whitespace-pre-wrap">{String(processing.receipt.before[field] ?? "empty")}</p></div><div><span className="text-text-subtle">After</span><p className="whitespace-pre-wrap">{String(processing.receipt.after[field] ?? "empty")}</p></div></dd>}</div>)}</dl><Link className="underline" href={processing.receipt.targetUrl}>Open updated item</Link></> : <p>Your transcript is saved. {processing.status === "RUNNING" ? "An update is already running; no additional request is needed." : "Follow the agent’s progress here."}</p>}
                <Link className="block underline" href={`${basePath}/capture/pm/${processing.interviewId}`}>View saved interview</Link>
                {!processing.receipt && (processing.status === "FAILED" || processing.status === "INTERRUPTED") && <Button disabled={isStreaming} onClick={() => void send(true, true)}>Retry update</Button>}
              </section>)}
            {messages.length === 0 && !isStreaming && !processing && !processingLoading && (
              <div className="flex flex-col items-center gap-3 py-16 text-center">
                <div className="flex size-12 items-center justify-center rounded-full bg-surface-interactive text-text-secondary">
                  <Sparkles className="size-6" aria-hidden="true" />
                </div>
                <p className="text-base font-medium text-text-primary">Ask the Compass agent</p>
                <p className="max-w-sm text-sm text-text-subtle">
                  It can read and update this workspace&apos;s opportunities, experiments, roadmap, OKRs, and more —
                  scoped to what you can access.
                </p>
              </div>
            )}

            {messages.map((m) => (
              <MessageRow key={m.id} message={m} userInitials={userInitials} userId={userId} shared={shared} workspaceId={workspaceId} conversationId={activeConversationId} basePath={basePath} />
            ))}

            {isStreaming && (
              <MessageRow
                message={{ id: "streaming", role: "assistant", content: streamingText, toolCalls: liveToolSteps, plan: livePlan, subagents: liveSubagents }}
                userInitials={userInitials}
                userId={userId}
                shared={shared}
                phaseLabel={phaseLabel}
                workspaceId={workspaceId}
                conversationId={activeConversationId}
                basePath={basePath}
              />
            )}

            {/* Only shown for a detached run, because it is only true of one: the
                synchronous fallback still dies with this request. */}
            {activeRun && !activeRun.done && runStartedByOther && (
              <p className="pl-10 text-xs text-text-subtle">
                {`${nameOf(runStarterId) ?? "Another participant"} asked this. You can watch, and send your own message once it finishes.`}
              </p>
            )}

            {accessLost && (
              <div role="alert" className="rounded-lg border border-default bg-surface-inset px-4 py-3 text-sm text-text-secondary">
                {accessLost === "left"
                  ? "You left this conversation. It no longer appears in your list."
                  : "You no longer have access to this conversation."}{" "}
                <Link className="underline" href={`${basePath}/agent`}>
                  Start a new chat
                </Link>
              </div>
            )}

            {error && (
              <div className="rounded-lg border border-default bg-status-danger-surface px-4 py-3 text-sm text-status-danger">
                {error}
              </div>
            )}
            {conversationPlan.length > 0 && (
              <div className="pl-10">
                <PlanCard plan={conversationPlan} running={isStreaming} taskHref={(taskId) => `${basePath}/tasks/${taskId}`} />
              </div>
            )}
            {linkedObjects.length > 0 && (
              <div className="pl-10">
                <LinkedObjectsCard items={linkedObjects} orgSlug={orgSlug} workspaceSlug={workspaceSlug} />
              </div>
            )}
            <div ref={bottomRef} />
          </div>
        </ScrollArea>

        <div className={`border-t border-default bg-surface-panel ${isRail ? "p-3" : "p-3 sm:p-4"}`}>
          {suggestion && !input.trim() && !composerDisabled && !isStreaming && (
            <div className="mx-auto mb-2 flex w-full max-w-3xl">
              <button
                type="button"
                data-testid="agent-prompt-suggestion"
                className="max-w-full truncate rounded-full border border-default bg-surface-inset px-3 py-1 text-left text-sm text-text-subtle hover:bg-surface-interactive hover:text-text-primary"
                title="Use this suggested reply"
                onClick={() => {
                  setInput(suggestion)
                  clearSuggestion()
                  composerRef.current?.focus()
                }}
              >
                {suggestion}
              </button>
            </div>
          )}
          <RecentMentions
            messages={messages}
            onInsert={(text) => {
              setInput((prev) => (prev.trim() ? prev.trimEnd() + " " + text : text))
              composerRef.current?.focus()
            }}
          />
          <ComposerCard
            textareaRef={composerRef}
            value={input}
            onChange={setInput}
            onSend={() => {
              if (canQueue) queueFollowUp()
              else if (!composerDisabled && input.trim()) void send()
            }}
            textareaDisabled={composerDisabled && !canQueue}
            sendDisabled={composerDisabled || !input.trim()}
            running={Boolean(activeRun && !activeRun.done)}
            onStop={() => { setQueued(null); if (activeRun) void cancelRun(activeRun.id) }}
            stopDisabled={!canCancelRun}
            stopTitle={canCancelRun ? "Stop this run (Esc)" : "Only the person who asked, or the owner, can stop this run"}
            readOnly={Boolean(accessLost)}
            onPasteText={accessLost ? undefined : pasteGoogleLinks}
            runStartedByMe={!runStartedByOther}
            status={(runStatusLine || queued) ? (
              <>
                {runStatusLine && (
                  <span className="flex min-w-0 items-center gap-2 text-[12.5px] text-muted-foreground">
                    <Loader2 className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                    <span className="min-w-0 truncate font-medium text-foreground">{runStatusLine}</span>
                  </span>
                )}
                {queued && (
                  <AttachedChip label={queued} hint="Queued, sends when the agent finishes" onRemove={() => setQueued(null)} />
                )}
              </>
            ) : null}
            contextChips={
              pendingSeedEntity || docChip || attachedItems.length || attachedUploads.length || googleResources.length || attachError ? (
                <>
                  {attachedItems.map((i) => (
                    <AttachedChip key={`${i.type}:${i.id}`} label={i.title} hint={i.typeLabel} onRemove={() => setAttachedItems((l) => l.filter((x) => x !== i))} />
                  ))}
                  {attachedUploads.map((u) => (
                    <AttachedChip key={u.ref} label={u.name} hint="File" file onRemove={() => setAttachedUploads((l) => l.filter((x) => x !== u))} />
                  ))}
                  {googleResources.map((r) => (
                    <AttachedChip key={r.fileId} label={r.label} hint={driveConnected ? "Google Drive" : "Google Drive (not connected)"} file onRemove={() => setGoogleResources((l) => l.filter((x) => x !== r))} />
                  ))}
                  {googleResources.length > 0 && !driveConnected && agentChoices.loaded && (
                    <span className="text-xs text-muted-foreground">Connect Google Drive in <Link href="/settings/agents" className="underline underline-offset-2">Settings → Agents</Link> so the agent can read this.</span>
                  )}
                  {attachError && <span role="alert" className="text-xs text-status-danger">{attachError}</span>}
                  {pendingSeedEntity && (
                    <SeedContextChip label={pendingSeedEntity.label} summary={pendingSeedEntity.summary} sourceUrl={pendingSeedEntity.sourceUrl} onDismiss={() => setPendingSeedEntity(undefined)} />
                  )}
                  {docChip && <SeedContextChip label={docChip.label} summary={docChip.summary} sourceUrl={docChip.sourceUrl} onDismiss={() => setDocChip(null)} />}
                </>
              ) : null
            }
            chips={
              <>
                {!accessLost && (
                  <AttachMenu
                    workspaceId={workspaceId}
                    orgSlug={orgSlug}
                    workspaceSlug={workspaceSlug}
                    disabled={composerDisabled}
                    uploadCount={attachedUploads.length}
                    items={attachedItems}
                    driveConnected={driveConnected}
                    googleResources={googleResources}
                    onPickGoogle={addGoogleResource}
                    onUploaded={(u) => { setAttachError(null); setAttachedUploads((l) => [...l, u]) }}
                    onPickItem={(i) => { setAttachError(null); setAttachedItems((l) => [...l, i]) }}
                    onError={setAttachError}
                  />
                )}
                {agentChoices.agents.length > 0 && (
                  <AgentChip choices={agentChoices} value={agentSelection} defaultAgentName={defaultAgentName} disabled={composerDisabled} onChange={setAgentPick} />
                )}
                <ToolsMenu connectors={agentChoices.connectors} enabled={connectorsEnabledFor(agentSelection, agentChoices.defaultAgentId, agentChoices.agents)} loaded={agentChoices.loaded} />
                {modelPick.visible && (
                  <ModelPicker choices={agentChoices} value={modelPick.model} defaultLabel={modelPick.defaultLabel} disabled={composerDisabled} onChange={modelPick.select} />
                )}
              </>
            }
          />
        </div>
      </div>
    </div>
  )
}

function AttachedChip({ label, hint, file, onRemove }: { label: string; hint: string; file?: boolean; onRemove: () => void }) {
  return (
    <div title={`${hint}: ${label}`} className="inline-flex h-6 min-w-0 max-w-full items-center gap-1 rounded-md border border-border bg-muted pr-0.5 pl-2 text-xs">
      {file && <FileText className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />}
      <span className="min-w-0 truncate font-medium text-foreground">{label}</span>
      <button type="button" aria-label={`Remove ${label}`} onClick={onRemove} className="relative grid size-[18px] shrink-0 place-items-center rounded text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
        <XIcon className="size-3" aria-hidden="true" />
      </button>
    </div>
  )
}

function MessageRow({
  message,
  userInitials,
  userId,
  shared,
  phaseLabel,
  workspaceId,
  conversationId,
  basePath,
}: {
  message: Message
  userInitials: string
  userId: string
  shared: boolean
  phaseLabel?: string | null
  workspaceId: string
  conversationId: string | null
  basePath: string
}) {
  const isUser = message.role === "user"
  // A message with no recorded author is this tab's own, not yet reported back.
  const fromOther = shared && isUser && Boolean(message.authorUserId) && message.authorUserId !== userId
  const authorName = fromOther ? (message.authorName ?? "Participant") : null
  return (
    <div className={`flex gap-3 ${isUser && !fromOther ? "flex-row-reverse" : "flex-row"}`}>
      <Avatar className="size-7 shrink-0">
        <AvatarFallback className={isUser ? "bg-surface-interactive text-text-secondary" : "bg-primary text-primary-foreground"}>
          {isUser ? (fromOther ? initialsOf(authorName) : userInitials) : <Sparkles className="size-4" aria-hidden="true" />}
        </AvatarFallback>
      </Avatar>
      <div className="flex min-w-0 max-w-[85%] flex-col gap-1">
        {authorName && <span className="px-1 text-xs text-text-subtle">{authorName}</span>}
        <div
          className={`min-w-0 rounded-xl px-4 py-2.5 text-sm ${
            isUser
              ? fromOther
                ? "border border-default bg-surface-inset text-text-primary"
                : "bg-primary text-primary-foreground"
              : "border border-default bg-surface-card text-text-primary"
          }`}
        >
          {!isUser && <AgentActivity toolCalls={message.toolCalls} plan={message.plan} subagents={message.subagents} running={message.id === "streaming"} workspaceId={workspaceId} conversationId={conversationId} basePath={basePath} />}
          {isUser && isApprovalUpdateMessage(message.content) ? (
            <div data-testid="approval-update-message">
              <p className="mb-1 text-xs font-medium text-text-subtle">Approval update (system-generated)</p>
              <p className="whitespace-pre-wrap break-words">{message.content.slice(APPROVAL_UPDATE_PREFIX.length)}</p>
            </div>
          ) : isUser ? (
            <p className="whitespace-pre-wrap break-words">{message.content}</p>
          ) : message.content ? (
            <Markdown>{message.content}</Markdown>
          ) : phaseLabel ? (
            <p className="flex items-center gap-1.5 text-text-subtle">
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              {phaseLabel}
            </p>
          ) : (
            <p className="text-text-subtle">…</p>
          )}
        </div>
      </div>
    </div>
  )
}

const STATUS_STYLE: Record<BoardColumnId, { label: string; dot: string; badge: string }> = {
  working: { label: "Working", dot: "bg-status-info animate-pulse", badge: "bg-status-info-surface text-status-info" },
  new: { label: "New", dot: "bg-status-warning", badge: "bg-status-warning-surface text-status-warning" },
  done: { label: "Done", dot: "bg-status-success", badge: "bg-status-success-surface text-status-success" },
  failed: { label: "Failed", dot: "bg-status-danger", badge: "bg-status-danger-surface text-status-danger" },
  ready: { label: "Ready", dot: "bg-status-neutral", badge: "bg-status-neutral-surface text-status-neutral" },
}

/** One chat-list row. With a status it shows a dot, a labelled badge and the time of last activity. */
function ConversationRow({
  c,
  status,
  active,
  basePath,
  archived,
  onToggleArchived,
}: {
  c: AgentListConversation
  status: BoardColumnId | null
  active: boolean
  basePath: string
  archived: boolean
  onToggleArchived: () => void
}) {
  const archiveLabel = archived ? "Restore chat" : "Archive chat"
  const style = status ? STATUS_STYLE[status] : null
  return (
    <li className="group relative">
      <Link
        href={basePath + "/agent?c=" + c.id}
        aria-current={active ? "page" : undefined}
        className={cn(
          "block rounded-lg py-2 pl-3 pr-9 text-sm transition-colors",
          active ? "bg-surface-interactive text-text-primary" : "text-text-secondary hover:bg-surface-interactive-hover hover:text-text-primary"
        )}
      >
        <span className="flex items-center gap-2">
          {style && <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", style.dot)} />}
          <span className={cn("min-w-0 flex-1 truncate", status === "new" && "font-semibold")}>{c.title || "Untitled chat"}</span>
        </span>
        {style && c.lastActivityAt && (
          <span className="mt-1 flex items-center gap-2 pl-4 text-xs">
            <span className={cn("rounded px-1.5 py-0.5 font-medium", style.badge)}>{style.label}</span>
            <span className="text-text-subtle">{formatRelativeTime(c.lastActivityAt)}</span>
          </span>
        )}
      </Link>
      <Button
        variant="ghost"
        size="icon-sm"
        className="absolute right-1 top-1.5 opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
        onClick={onToggleArchived}
        aria-label={archiveLabel}
        title={archiveLabel}
      >
        {archived ? <ArchiveRestore aria-hidden="true" /> : <Archive aria-hidden="true" />}
      </Button>
    </li>
  )
}
