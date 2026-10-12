"use client"

import Link from "next/link"
import { useCallback, useState } from "react"
import { PanelLeftClose, PanelLeftOpen, Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { WorkspacePage } from "@/components/patterns/workspace-page"
import { AGENT_LIST_COOKIE } from "@/lib/agent-list-pref"
import { AgentChat } from "@/components/agent/agent-chat"

type ChatProps = Omit<Parameters<typeof AgentChat>[0], "listOpen" | "variant">

/**
 * The agent page's title bar and chat, joined so the bar can own the chat-list
 * toggle. The toggle sits left of the title (and is the only thing that brings
 * a hidden list back, since collapsing removes the list entirely); "New chat"
 * sits top right. The state lives here because both the bar and the chat need
 * it; the cookie keeps it across loads and lets the server paint the right
 * state on the first frame.
 */
export function AgentPageShell({
  initialListOpen,
  basePath,
  ...chat
}: ChatProps & { initialListOpen: boolean }) {
  const [listOpen, setListOpen] = useState(initialListOpen)
  const toggleList = useCallback(() => {
    const next = !listOpen
    setListOpen(next)
    document.cookie = `${AGENT_LIST_COOKIE}=${next ? "1" : "0"}; path=/; max-age=${60 * 60 * 24 * 365}`
  }, [listOpen])

  const label = listOpen ? "Hide chat list" : "Show chat list"
  return (
    // p-0 so the chat runs edge to edge under the bar — the same move the Tasks
    // board makes. The chat supplies its own column padding.
    <WorkspacePage
      leading={
        // Below md the list is hidden outright, so the toggle would do nothing.
        <Button
          variant="ghost"
          size="icon-sm"
          className="hidden md:inline-flex"
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
        <Button variant="outline" size="sm" className="gap-2" render={<Link href={`${basePath}/agent`} />}>
          <Plus className="size-4" aria-hidden="true" />
          New chat
        </Button>
      }
      contentClassName="p-0 sm:p-0 md:p-0"
    >
      <AgentChat {...chat} basePath={basePath} listOpen={listOpen} />
    </WorkspacePage>
  )
}
