"use client"

import Link from "next/link"
import { useCallback, useState } from "react"
import { Columns3, MessageSquare, PanelLeftClose, PanelLeftOpen, Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { WorkspacePage, WorkspaceViewSwitcher } from "@/components/patterns"
import { AGENT_LIST_COOKIE } from "@/lib/agent-list-pref"
import { AGENT_VIEW_COOKIE, parseAgentView, type AgentView } from "@/lib/agent-view-pref"
import type { AgentBoardCard } from "@/lib/agent-board"
import { AgentChat } from "@/components/agent/agent-chat"
import { AgentBoard } from "@/components/agent/agent-board"
import { cn } from "@/lib/utils"

type ChatProps = Omit<Parameters<typeof AgentChat>[0], "listOpen" | "variant">

const ONE_YEAR = 60 * 60 * 24 * 365

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
  basePath,
  ...chat
}: ChatProps & { initialListOpen: boolean; initialView: AgentView; initialBoardCards: AgentBoardCard[] | null }) {
  const [listOpen, setListOpen] = useState(initialListOpen)
  const [view, setView] = useState<AgentView>(initialView)
  // The server-painted cards are only right for the first frame; any later mount of the board starts from a fetch.
  const [boardSeed, setBoardSeed] = useState(initialBoardCards)
  const toggleList = useCallback(() => {
    const next = !listOpen
    setListOpen(next)
    document.cookie = `${AGENT_LIST_COOKIE}=${next ? "1" : "0"}; path=/; max-age=${ONE_YEAR}`
  }, [listOpen])

  const { workspaceId, activeConversationId } = chat

  const changeView = useCallback(
    (next: AgentView) => {
      document.cookie = `${AGENT_VIEW_COOKIE}=${next}; path=/; max-age=${ONE_YEAR}`
      setBoardSeed(null)
      if (next === "board" && activeConversationId) {
        // Leaving a conversation for the board means you have seen it: record that first, so the board's
        // first fetch doesn't show the chat you were just reading as New.
        void markReviewed(workspaceId, activeConversationId).then(() => setView(next))
        return
      }
      setView(next)
    },
    [workspaceId, activeConversationId]
  )

  const openFromBoard = useCallback(
    (conversationId: string) => {
      // The card is a link (?c=<id>), so navigation is the link's own; this switches the shell to the chat
      // and records the review.
      document.cookie = `${AGENT_VIEW_COOKIE}=chat; path=/; max-age=${ONE_YEAR}`
      setView("chat")
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
        <AgentChat {...chat} basePath={basePath} listOpen={listOpen} />
      </div>
      {view === "board" && (
        <AgentBoard
          workspaceId={workspaceId}
          basePath={basePath}
          initialCards={boardSeed}
          onOpenConversation={openFromBoard}
        />
      )}
    </WorkspacePage>
  )
}
