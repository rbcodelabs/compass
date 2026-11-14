"use client"

import Link from "next/link"
import { useCallback, useEffect, useMemo, useState } from "react"
import { Columns3, MessageSquare, PanelLeftClose, PanelLeftOpen, Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { WorkspacePage, WorkspaceViewSwitcher } from "@/components/patterns"
import { AGENT_LIST_COOKIE } from "@/lib/agent-list-pref"
import { AGENT_VIEW_COOKIE, parseAgentView, type AgentView } from "@/lib/agent-view-pref"
import type { AgentBoardCard, AgentBoardCardSquad } from "@/lib/agent-board"
import { AgentChat } from "@/components/agent/agent-chat"
import { AgentBoard } from "@/components/agent/agent-board"
import { cn } from "@/lib/utils"

type ChatProps = Omit<Parameters<typeof AgentChat>[0], "listOpen" | "variant" | "reviewedIds" | "squads" | "teamOpenRequest">

const ONE_YEAR = 60 * 60 * 24 * 365

/** How long you must stay on a chat before it counts as read. */
const REVIEW_DWELL_MS = 2000

/** Fire-and-forget: the user's navigation must never wait on, or fail because of, the review write. */
function markReviewed(workspaceId: string, conversationId: string) {
  return fetch(
    `/api/agent/conversations/${conversationId}/review?workspaceId=${encodeURIComponent(workspaceId)}`,
    { method: "POST", keepalive: true }
  ).catch(() => {})
}

/**
 * The agent page's title bar and its two views, joined so the bar can own the controls. The chat-list
 * toggle sits left of the title (and is the only thing that brings a hidden list back, since collapsing
 * removes the list entirely); the Chat | Board switcher and "New chat" sit top right. The state lives here
 * because both the bar and the views need it; cookies keep it across loads and let the server paint the right
 * state on the first frame.
 *
 * The chat stays mounted while the board is showing (hidden, not unmounted), so switching views mid-turn
 * neither drops the stream nor loses a half-typed message.
 */
export function AgentPageShell({
  initialListOpen,
  initialView,
  initialBoardCards,
  initialSquads,
  basePath,
  ...chat
}: ChatProps & {
  initialListOpen: boolean
  initialView: AgentView
  initialBoardCards: AgentBoardCard[] | null
  initialSquads?: AgentBoardCardSquad[]
}) {
  const [listOpen, setListOpen] = useState(initialListOpen)
  const [view, setView] = useState<AgentView>(initialView)
  // The server-painted cards are only right for the first frame; any later mount of the board starts from a fetch.
  // Chats that passed the dwell this session. The server-rendered list is stale until a reload, so the list reads this.
  const [reviewedIds, setReviewedIds] = useState<ReadonlySet<string>>(() => new Set())
  const [boardSeed, setBoardSeed] = useState(initialBoardCards)
  const [liveCards, setLiveCards] = useState<AgentBoardCard[] | null>(initialBoardCards)
  const [teamOpenRequest, setTeamOpenRequest] = useState<{ conversationId: string; nonce: number } | null>(null)
  const mergedConversations = useMemo(() => {
    if (!liveCards) return chat.conversations
    return liveCards.map((card) => ({
      id: card.id,
      title: card.title,
      messageCount: card.messageCount,
      runStatus: card.runStatus,
      lastActivityAt: card.lastActivityAt,
      reviewedAt: card.reviewedAt,
      squad: card.squad ?? null,
      summary: card.summary ?? null,
      prUrl: card.prUrl ?? null,
      substatus: card.substatus ?? null,
      currentActivity: card.currentActivity ?? null,
      lastHeartbeatAt: card.lastHeartbeatAt ?? null,
      subtasks: card.subtasks,
      childAgents: card.childAgents,
    }))
  }, [chat.conversations, liveCards])
  const toggleList = useCallback(() => {
    const next = !listOpen
    setListOpen(next)
    document.cookie = `${AGENT_LIST_COOKIE}=${next ? "1" : "0"}; path=/; max-age=${ONE_YEAR}`
  }, [listOpen])

  const { workspaceId, activeConversationId } = chat

  // Reading a chat counts as reviewing it, but only once you have stayed on it for REVIEW_DWELL_MS, so skimming
  // past a chat in the list does not mark it. If you stay and leave later, the review is written again on the way
  // out, which covers replies that arrived while you were watching.
  useEffect(() => {
    if (view !== "chat" || !activeConversationId) return
    let dwelled = false
    const timer = setTimeout(() => {
      dwelled = true
      setReviewedIds((prev) => new Set(prev).add(activeConversationId))
      void markReviewed(workspaceId, activeConversationId)
    }, REVIEW_DWELL_MS)
    return () => {
      clearTimeout(timer)
      if (dwelled) void markReviewed(workspaceId, activeConversationId)
    }
  }, [view, workspaceId, activeConversationId])

  const changeView = useCallback(
    (next: AgentView) => {
      document.cookie = `${AGENT_VIEW_COOKIE}=${next}; path=/; max-age=${ONE_YEAR}`
      setBoardSeed(null)
      if (next === "board" && activeConversationId) {
        // Leaving a conversation for the board means you have seen it: record that first, so the board's
        // first fetch doesn't show the chat you were just reading as New.
        // Bounded: a slow write must not leave the toggle looking dead; the board just shows it as New for a moment.
        void Promise.race([markReviewed(workspaceId, activeConversationId), new Promise((resolve) => setTimeout(resolve, 1500))]).then(() => setView(next))
        return
      }
      setView(next)
    },
    [workspaceId, activeConversationId]
  )

  const openFromBoard = useCallback(
    (conversationId: string, options?: { openTeam?: boolean }) => {
      // The card is a link (?c=<id>), so navigation is the link's own; this switches the shell to the chat
      // and records the review.
      document.cookie = `${AGENT_VIEW_COOKIE}=chat; path=/; max-age=${ONE_YEAR}`
      setView("chat")
      if (options?.openTeam) {
        setTeamOpenRequest((prev) => ({ conversationId, nonce: (prev?.nonce ?? 0) + 1 }))
      }
      void markReviewed(workspaceId, conversationId)
    },
    [workspaceId]
  )

  const label = listOpen ? "Hide chat list" : "Show chat list"
  return (
    // p-0 so the chat runs edge to edge under the bar — the same move the Tasks
    // board makes. The chat supplies its own column padding.
    <WorkspacePage
      leading={
        // Below md the list is hidden outright, so the toggle would do nothing. It also does nothing on the board.
        <Button
          variant="ghost"
          size="icon-sm"
          className={cn("hidden", view === "chat" && "md:inline-flex")}
          onClick={toggleList}
          aria-label={label}
          aria-expanded={listOpen}
          title={label}
        >
          {listOpen ? <PanelLeftClose className="size-4" aria-hidden="true" /> : <PanelLeftOpen className="size-4" aria-hidden="true" />}
        </Button>
      }
      title="Agent"
      actions={
        <>
          <WorkspaceViewSwitcher
            label="Agent view"
            value={view}
            onValueChange={(next) => changeView(parseAgentView(next))}
            options={[
              { value: "chat", label: "Chat", icon: <MessageSquare aria-hidden="true" /> },
              { value: "board", label: "Board", icon: <Columns3 aria-hidden="true" /> },
            ]}
          />
          <Button
            variant="outline"
            size="sm"
            className="gap-2"
            nativeButton={false}
            // Starting a chat from the board means going to the chat; the saved view follows.
            onClick={() => {
              document.cookie = `${AGENT_VIEW_COOKIE}=chat; path=/; max-age=${ONE_YEAR}`
              setView("chat")
            }}
            render={<Link href={`${basePath}/agent`} />}
          >
            <Plus className="size-4" aria-hidden="true" />
            New chat
          </Button>
        </>
      }
      contentClassName="p-0 sm:p-0 md:p-0"
    >
      <div className={cn("flex min-h-0 flex-1 flex-col", view !== "chat" && "hidden")}>
        <AgentChat
          {...chat}
          conversations={mergedConversations}
          basePath={basePath}
          listOpen={listOpen}
          reviewedIds={reviewedIds}
          squads={initialSquads}
          teamOpenRequest={teamOpenRequest}
        />
      </div>
      {view === "board" && (
        <AgentBoard
          workspaceId={workspaceId}
          basePath={basePath}
          initialCards={boardSeed}
          squads={initialSquads}
          onOpenConversation={openFromBoard}
          onCardsChange={setLiveCards}
        />
      )}
    </WorkspacePage>
  )
}
