"use client"

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { Check, MessagesSquare, Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { usePanelContext, type PanelType } from "@/components/panels/panel-context"
import { leaveArchivedConversation } from "@/components/panels/leave-archived-conversation"
import { isComposerPanelType } from "@/components/panels/composer-panel-types"
import { panelTitles } from "@/components/panels/panel-titles"
import { useLabels } from "@/components/thinking-model/thinking-model-provider"
import { AgentChat } from "@/components/agent/agent-chat"
import { CommentDeepLinkOpener } from "@/components/panels/comment-deep-link-opener"
import { isCommentId } from "@/lib/comment-deep-link"
import { LegacyRailLinkRedirect } from "@/components/panels/legacy-rail-link-redirect"
import { parseConversationMessagesResponse, type PanelLoadedMessage } from "@/lib/conversation-panel-messages"
import type { CommentTaskCardData } from "@/lib/comment-task-card"
import type {
  AgentParticipationMode,
  ConversationStatus,
  ConversationVisibility,
} from "@/lib/agent-participation-mode"

export type PanelHistoryCrumb = {
  type: PanelType
  id: string
  label: string
}

type PendingConversationSeed = {
  targetType?: string | null
  targetId?: string | null
  targetLabel?: string | null
  agentMode?: AgentParticipationMode
  visibility?: ConversationVisibility
  suggestedInstruction?: string
}

type ConversationThreadItem = {
  id: string
  title: string | null
  snippet?: string | null
}

type ConversationPanelContextValue = {
  workspaceId: string
  userId: string
  userInitials: string
  orgSlug: string
  workspaceSlug: string
  historyStack: PanelHistoryCrumb[]
  jumpToCrumb: (index: number) => void
  threads: ConversationThreadItem[]
  refreshThreads: () => Promise<void>
  pendingSeed: PendingConversationSeed | null
  clearPendingSeed: () => void
  openConversationInPanel: (
    conversationId: string,
    options?: {
      label?: string
      targetType?: string | null
      targetId?: string | null
      targetLabel?: string | null
      agentMode?: AgentParticipationMode
      visibility?: ConversationVisibility
    },
  ) => void
  startNewConversationInPanel: (options?: PendingConversationSeed) => void
  adoptCreatedConversationId: (conversationId: string, title?: string | null) => void
}

const ConversationPanelContext = createContext<ConversationPanelContextValue | null>(null)

export function useConversationPanelOptional() {
  return useContext(ConversationPanelContext)
}

function initialCrumbLabel(
  type: PanelType,
  id: string,
  titles: Record<string, string>,
  custom?: string,
): string {
  if (custom) return custom
  if (type === "conversation") {
    return id === "new" ? "New chat" : "Conversation"
  }
  return titles[type] ?? "Item"
}

export function ConversationPanelProvider({
  workspaceId,
  userId,
  userInitials,
  orgSlug,
  workspaceSlug,
  children,
}: {
  workspaceId: string
  userId: string
  userInitials: string
  orgSlug: string
  workspaceSlug: string
  children: ReactNode
}) {
  const { panel, openPanel } = usePanelContext()
  const labels = useLabels()
  const pathname = usePathname()
  const router = useRouter()
  const [historyStack, setHistoryStack] = useState<PanelHistoryCrumb[]>([])
  const [threads, setThreads] = useState<ConversationThreadItem[]>([])
  const [pendingSeed, setPendingSeed] = useState<PendingConversationSeed | null>(null)
  const customLabelsRef = useRef(new Map<string, string>())
  const resolvedLabelsRef = useRef(new Map<string, string>())

  const refreshThreads = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/agent/conversations?workspaceId=${encodeURIComponent(workspaceId)}`,
      )
      if (!res.ok) return
      const body = (await res.json()) as { conversations?: ConversationThreadItem[] }
      if (Array.isArray(body.conversations)) {
        setThreads(body.conversations)
        for (const t of body.conversations) {
          if (t.id && t.title) {
            resolvedLabelsRef.current.set(`conversation:${t.id}`, t.title)
          }
        }
      }
    } catch {
      // Best-effort
    }
  }, [workspaceId])

  useEffect(() => {
    void refreshThreads()
  }, [refreshThreads])

  // Track panel navigation in the non-wrapping breadcrumb stack and resolve human-readable titles.
  useEffect(() => {
    if (!panel) {
      setHistoryStack([])
      return
    }
    if (isComposerPanelType(panel.type) || panel.type === "discovery-rail") {
      return
    }
    const key = `${panel.type}:${panel.id}`
    const knownLabel =
      customLabelsRef.current.get(key) ??
      resolvedLabelsRef.current.get(key) ??
      initialCrumbLabel(panel.type, panel.id, panelTitles(labels))

    setHistoryStack((prev) => {
      const existingIdx = prev.findIndex((c) => c.type === panel.type && c.id === panel.id)
      if (existingIdx !== -1) {
        const sliced = prev.slice(0, existingIdx + 1)
        if (knownLabel && sliced[existingIdx]!.label !== knownLabel) {
          sliced[existingIdx] = { ...sliced[existingIdx]!, label: knownLabel }
        }
        return sliced
      }
      return [...prev.slice(-7), { type: panel.type, id: panel.id, label: knownLabel }]
    })

    if (panel.type === "conversation") {
      if (panel.id === "new") return
      let cancelled = false
      void (async () => {
        try {
          const res = await fetch(
            `/api/agent/conversations/${encodeURIComponent(panel.id)}/settings?workspaceId=${encodeURIComponent(workspaceId)}`,
          )
          if (!res.ok || cancelled) return
          const data = (await res.json()) as { title?: string | null; targetLabel?: string | null }
          const label = data.title?.trim() || data.targetLabel || "Conversation"
          resolvedLabelsRef.current.set(key, label)
          setHistoryStack((prev) =>
            prev.map((c) => (c.type === "conversation" && c.id === panel.id ? { ...c, label } : c)),
          )
        } catch {
          // Best-effort
        }
      })()
      return () => {
        cancelled = true
      }
    }

    if (resolvedLabelsRef.current.has(key)) return
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch(
          `/api/panels/entity/${encodeURIComponent(panel.type)}/${encodeURIComponent(panel.id)}?orgSlug=${encodeURIComponent(orgSlug)}&workspaceSlug=${encodeURIComponent(workspaceSlug)}`,
        )
        if (!res.ok || cancelled) return
        const payload = (await res.json()) as { data?: Record<string, unknown> }
        const data = payload?.data
        if (!data || typeof data !== "object") return
        const displayId = typeof data.displayId === "string" ? data.displayId : null
        const title =
          typeof data.title === "string"
            ? data.title
            : typeof data.statement === "string"
              ? data.statement
              : typeof data.name === "string"
                ? data.name
                : null
        const resolved =
          displayId && title ? `${displayId} · ${title}` : displayId ?? title ?? null
        if (!resolved || cancelled) return
        resolvedLabelsRef.current.set(key, resolved)
        setHistoryStack((prev) =>
          prev.map((c) => (c.type === panel.type && c.id === panel.id ? { ...c, label: resolved } : c)),
        )
      } catch {
        // Best-effort
      }
    })()
    return () => {
      cancelled = true
    }
  }, [panel, workspaceId, orgSlug, workspaceSlug, labels])

  const jumpToCrumb = useCallback(
    (index: number) => {
      const target = historyStack[index]
      if (!target) return
      setHistoryStack((prev) => prev.slice(0, index + 1))
      openPanel(target.type, target.id)
    },
    [historyStack, openPanel],
  )

  const openConversationInPanel = useCallback(
    (
      conversationId: string,
      options?: {
        label?: string
        targetType?: string | null
        targetId?: string | null
        targetLabel?: string | null
        agentMode?: AgentParticipationMode
        visibility?: ConversationVisibility
      },
    ) => {
      if (options?.label) {
        customLabelsRef.current.set(`conversation:${conversationId}`, options.label)
      }
      if (options?.targetType || options?.agentMode || options?.visibility) {
        setPendingSeed({
          targetType: options.targetType ?? null,
          targetId: options.targetId ?? null,
          targetLabel: options.targetLabel ?? null,
          agentMode: options.agentMode,
          visibility: options.visibility,
        })
      } else {
        setPendingSeed(null)
      }
      if (pathname?.endsWith("/conversations")) {
        router.push(`/${orgSlug}/${workspaceSlug}/conversations?c=${encodeURIComponent(conversationId)}`)
        return
      }
      openPanel("conversation", conversationId)
    },
    [openPanel, pathname, router, orgSlug, workspaceSlug],
  )

  const startNewConversationInPanel = useCallback(
    (options?: PendingConversationSeed) => {
      setPendingSeed(options ?? { agentMode: "AUTO", visibility: "PRIVATE" })
      const label = options?.targetLabel ? `Chat · ${options.targetLabel}` : "New chat"
      customLabelsRef.current.set("conversation:new", label)
      if (pathname?.endsWith("/conversations")) {
        router.push(`/${orgSlug}/${workspaceSlug}/conversations`)
        return
      }
      openPanel("conversation", "new")
    },
    [openPanel, pathname, router, orgSlug, workspaceSlug],
  )

  const adoptCreatedConversationId = useCallback(
    (conversationId: string, title?: string | null) => {
      if (title) {
        resolvedLabelsRef.current.set(`conversation:${conversationId}`, title)
      }
      setHistoryStack((prev) =>
        prev.map((c) =>
          c.type === "conversation" && c.id === "new"
            ? { ...c, id: conversationId, label: title || c.label }
            : c,
        ),
      )
      openPanel("conversation", conversationId)
      void refreshThreads()
    },
    [openPanel, refreshThreads],
  )

  // Global ⌘J / Ctrl+J shortcut opens a new chat in the Right PanelShell (unless on /conversations).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "j" || !(event.metaKey || event.ctrlKey)) return
      if (event.altKey || event.shiftKey) return
      event.preventDefault()
      startNewConversationInPanel({ agentMode: "AUTO", visibility: "PRIVATE" })
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [startNewConversationInPanel])

  const value = useMemo<ConversationPanelContextValue>(
    () => ({
      workspaceId,
      userId,
      userInitials,
      orgSlug,
      workspaceSlug,
      historyStack,
      jumpToCrumb,
      threads,
      refreshThreads,
      pendingSeed,
      clearPendingSeed: () => setPendingSeed(null),
      openConversationInPanel,
      startNewConversationInPanel,
      adoptCreatedConversationId,
    }),
    [
      workspaceId,
      userId,
      userInitials,
      orgSlug,
      workspaceSlug,
      historyStack,
      jumpToCrumb,
      threads,
      refreshThreads,
      pendingSeed,
      openConversationInPanel,
      startNewConversationInPanel,
      adoptCreatedConversationId,
    ],
  )

  return (
    <ConversationPanelContext.Provider value={value}>
      <CommentDeepLinkOpener />
      <LegacyRailLinkRedirect />
      {children}
    </ConversationPanelContext.Provider>
  )
}

export function ConversationPanelHeaderActions() {
  const ctx = useConversationPanelOptional()
  const { panel } = usePanelContext()
  if (!ctx) return null

  const activeId = panel?.type === "conversation" ? panel.id : null

  return (
    <div className="flex items-center gap-0.5">
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => ctx.startNewConversationInPanel({ agentMode: "AUTO", visibility: "PRIVATE" })}
        aria-label="New chat"
        title="New chat (⌘J)"
      >
        <Plus className="size-4" aria-hidden="true" />
      </Button>
      <DropdownMenu onOpenChange={(open) => { if (open) void ctx.refreshThreads() }}>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Switch conversation"
              title="Switch conversation"
            />
          }
        >
          <MessagesSquare className="size-4" aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72">
          <DropdownMenuItem
            onClick={() => ctx.startNewConversationInPanel({ agentMode: "AUTO", visibility: "PRIVATE" })}
            className="gap-2 font-medium"
          >
            <Plus className="size-3.5" aria-hidden="true" />
            <span>New chat</span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {ctx.threads.length === 0 ? (
            <div className="px-2 py-3 text-center text-xs text-text-subtle">
              No recent conversations
            </div>
          ) : (
            ctx.threads.slice(0, 15).map((t) => (
              <DropdownMenuItem
                key={t.id}
                onClick={() => ctx.openConversationInPanel(t.id, { label: t.title || "Conversation" })}
                className="flex items-center justify-between gap-2 text-xs"
              >
                <span className="truncate">{t.title || "Untitled chat"}</span>
                {t.id === activeId && <Check className="size-3.5 shrink-0 text-primary" aria-hidden="true" />}
              </DropdownMenuItem>
            ))
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

type LoadedMessage = PanelLoadedMessage

const EMPTY_MESSAGES: LoadedMessage[] = []
const EMPTY_TASK_CARDS: Record<string, CommentTaskCardData> = {}

function targetTypeToPanelType(targetType: string): PanelType | null {
  switch (targetType.toUpperCase()) {
    case "OPPORTUNITY":
      return "opportunity"
    case "SOLUTION":
      return "solution"
    case "TASK":
      return "task"
    case "ROADMAP_ITEM":
      return "roadmapItem"
    case "EXPERIMENT":
      return "experiment"
    case "ASSUMPTION":
      return "assumption"
    case "OBJECTIVE":
      return "objective"
    case "KEY_RESULT":
      return "keyResult"
    case "FEEDBACK":
    case "FEEDBACK_ITEM":
      return "feedback"
    default:
      return null
  }
}

export function ConversationPanel({ conversationId }: { conversationId: string }) {
  const ctx = useConversationPanelOptional()
  const { openPanel, closePanel } = usePanelContext()
  // `?comment=<messageId>` (set by the deep-link opener, or present on a shared link) names the message to highlight.
  const linkedMessageId = useSearchParams().get("comment")
  const focusMessageId = isCommentId(linkedMessageId) ? linkedMessageId : undefined
  const isNew = conversationId === "new"
  const activeConversationId = isNew ? null : conversationId

  const [messagesState, setMessagesState] = useState<{
    id: string
    messages: LoadedMessage[]
    taskCards: Record<string, CommentTaskCardData>
  }>({ id: conversationId, messages: EMPTY_MESSAGES, taskCards: EMPTY_TASK_CARDS })

  const [settingsState, setSettingsState] = useState<{
    id: string
    agentMode: AgentParticipationMode
    visibility: ConversationVisibility
    status: ConversationStatus
    targetType: string | null
    targetId: string | null
    targetLabel: string | null
    canArchive: boolean
    canRestore: boolean
    archived: boolean
  } | null>(null)

  useEffect(() => {
    if (!ctx || isNew) return
    const controller = new AbortController()
    const qs = `workspaceId=${encodeURIComponent(ctx.workspaceId)}`
    void Promise.all([
      fetch(`/api/agent/conversations/${encodeURIComponent(conversationId)}/messages?${qs}`, {
        signal: controller.signal,
      })
        .then(async (res) => {
          if (!res.ok) return
          const parsed = parseConversationMessagesResponse(await res.json())
          if (!parsed) return
          setMessagesState({ id: conversationId, messages: parsed.messages, taskCards: parsed.taskCards })
        })
        .catch(() => {}),
      fetch(`/api/agent/conversations/${encodeURIComponent(conversationId)}/settings?${qs}`, {
        signal: controller.signal,
      })
        .then(async (res) => {
          if (!res.ok) return
          const body = (await res.json()) as {
            agentMode?: AgentParticipationMode
            visibility?: ConversationVisibility
            status?: ConversationStatus
            targetType?: string | null
            targetId?: string | null
            targetLabel?: string | null
            canArchive?: boolean
            canRestore?: boolean
            archived?: boolean
          }
          setSettingsState({
            id: conversationId,
            agentMode: body.agentMode ?? "AUTO",
            visibility: body.visibility ?? "PRIVATE",
            status: body.status ?? "OPEN",
            targetType: body.targetType ?? null,
            targetId: body.targetId ?? null,
            targetLabel: body.targetLabel ?? null,
            canArchive: body.canArchive === true,
            canRestore: body.canRestore === true,
            archived: body.archived === true,
          })
        })
        .catch(() => {}),
    ])
    return () => controller.abort()
  }, [ctx, conversationId, isNew])

  if (!ctx) return null

  const initialMessages =
    !isNew && messagesState.id === conversationId ? messagesState.messages : EMPTY_MESSAGES
  const currentSettings = !isNew && settingsState?.id === conversationId ? settingsState : null
  const seed = ctx.pendingSeed

  const initialTargetType = currentSettings?.targetType ?? seed?.targetType ?? null
  const initialTargetId = currentSettings?.targetId ?? seed?.targetId ?? null
  const initialTargetLabel = currentSettings?.targetLabel ?? seed?.targetLabel ?? null
  const initialVisibility: ConversationVisibility =
    currentSettings?.visibility ??
    seed?.visibility ??
    (initialTargetType && initialTargetId ? "WORKSPACE" : "PRIVATE")
  const initialAgentMode: AgentParticipationMode =
    currentSettings?.agentMode ??
    seed?.agentMode ??
    (initialVisibility === "WORKSPACE" ? "MENTION_ONLY" : "AUTO")
  const initialStatus: ConversationStatus = currentSettings?.status ?? "OPEN"

  return (
    <AgentChat
      variant="rail"
      routeSegment="conversations"
      workspaceId={ctx.workspaceId}
      basePath={`/${ctx.orgSlug}/${ctx.workspaceSlug}`}
      conversations={ctx.threads.map((t) => ({ id: t.id, title: t.title }))}
      activeConversationId={activeConversationId}
      initialMessages={initialMessages}
      userId={ctx.userId}
      userInitials={ctx.userInitials}
      suggestedInstruction={isNew ? seed?.suggestedInstruction : undefined}
      initialAgentMode={initialAgentMode}
      initialVisibility={initialVisibility}
      initialStatus={initialStatus}
      initialTargetType={initialTargetType}
      initialTargetId={initialTargetId}
      initialTargetLabel={initialTargetLabel}
      canArchive={currentSettings?.canArchive === true}
      canRestore={currentSettings?.canRestore === true}
      initialArchived={currentSettings?.archived === true}
      focusMessageId={focusMessageId}
      onConversationArchived={() =>
        leaveArchivedConversation({ historyStack: ctx.historyStack, jumpToCrumb: ctx.jumpToCrumb, closePanel })
      }
      onConversationCreated={(createdId) => {
        ctx.adoptCreatedConversationId(createdId)
      }}
      onOpenTargetObject={(targetType, targetId) => {
        const panelType = targetTypeToPanelType(targetType)
        if (panelType) openPanel(panelType, targetId)
      }}
    />
  )
}
