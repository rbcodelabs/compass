"use client"

// Agent chat surface (ADR 0001, Phase 4). Consumes the SSE stream from
// POST /api/agent/turn (the Phase 3 turn service) and renders a conversation.
//
// Conversation selection is server-driven via the `?c=<id>` search param (the
// page server-loads that conversation's messages), so this component only owns
// the active thread + composer + live streaming of the current turn.

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { Plus, Send, Sparkles, Wrench } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { parseSseFrames } from "@/lib/sse-frames"

type Role = "user" | "assistant"
type Message = { id: string; role: Role; content: string }
type ConversationSummary = { id: string; title: string | null }

type Props = {
  workspaceId: string
  basePath: string // `/${orgSlug}/${workspaceSlug}`
  conversations: ConversationSummary[]
  activeConversationId: string | null
  initialMessages: Message[]
  userInitials: string
}

type StreamPhase = "idle" | "booting" | "running"

export function AgentChat({
  workspaceId,
  basePath,
  conversations,
  activeConversationId,
  initialMessages,
  userInitials,
}: Props) {
  const router = useRouter()
  const [messages, setMessages] = useState<Message[]>(initialMessages)
  const [input, setInput] = useState("")
  const [phase, setPhase] = useState<StreamPhase>("idle")
  const [streamingText, setStreamingText] = useState("")
  const [toolActivity, setToolActivity] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  const isStreaming = phase !== "idle"

  // Reset when the server swaps the active conversation.
  useEffect(() => {
    setMessages(initialMessages)
    setStreamingText("")
    setToolActivity(null)
    setError(null)
    setPhase("idle")
  }, [activeConversationId, initialMessages])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" })
  }, [messages, streamingText, phase])

  const send = useCallback(async () => {
    const text = input.trim()
    if (!text || isStreaming) return
    setInput("")
    setError(null)
    setMessages((m) => [...m, { id: `local-${Date.now()}`, role: "user", content: text }])
    setPhase("booting")
    setStreamingText("")
    setToolActivity(null)

    let assembled = ""
    let newConversationId: string | null = null
    try {
      const res = await fetch("/api/agent/turn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId, message: text, conversationId: activeConversationId ?? undefined }),
      })
      if (!res.ok || !res.body) {
        throw new Error(res.status === 401 ? "Your session expired — reload and sign in." : `Request failed (${res.status}).`)
      }
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const { frames, rest } = parseSseFrames(buffer)
        buffer = rest
        for (const { event, data } of frames) {
          let payload: unknown
          try {
            payload = JSON.parse(data)
          } catch {
            continue
          }
          const p = payload as Record<string, unknown>
          if (event === "status") {
            setPhase(p.phase === "running" ? "running" : "booting")
            if (typeof p.conversationId === "string") newConversationId = p.conversationId
          } else if (event === "agent") {
            const m = (p.message ?? {}) as Record<string, unknown>
            const inner = (m.message ?? {}) as Record<string, unknown>
            const content = inner.content
            if (Array.isArray(content)) {
              for (const block of content as Record<string, unknown>[]) {
                if (block.type === "text" && typeof block.text === "string") {
                  assembled += block.text
                  setStreamingText(assembled)
                } else if (block.type === "tool_use" && typeof block.name === "string") {
                  setToolActivity(String(block.name).replace(/^mcp__compass__/, ""))
                }
              }
            }
          } else if (event === "result") {
            if (typeof p.text === "string" && p.text) assembled = p.text
            if (typeof p.conversationId === "string") newConversationId = p.conversationId
          } else if (event === "error") {
            throw new Error(typeof p.message === "string" ? p.message : "The agent hit an error.")
          }
        }
      }

      setMessages((m) => [...m, { id: `a-${Date.now()}`, role: "assistant", content: assembled || "(no response)" }])
      setStreamingText("")
      setToolActivity(null)
      setPhase("idle")
      // Pin a newly-created conversation into the URL + refresh the list.
      if (newConversationId && newConversationId !== activeConversationId) {
        router.replace(`${basePath}/agent?c=${newConversationId}`)
        router.refresh()
      } else {
        router.refresh()
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.")
      setStreamingText("")
      setToolActivity(null)
      setPhase("idle")
    }
  }, [input, isStreaming, workspaceId, activeConversationId, basePath, router])

  const statusLabel = useMemo(() => {
    if (phase === "booting") return "Starting the agent…"
    if (phase === "running") return toolActivity ? `Using ${toolActivity}…` : "Thinking…"
    return null
  }, [phase, toolActivity])

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden rounded-xl border border-default bg-surface-panel">
      {/* Conversation list */}
      <aside className="hidden w-64 shrink-0 flex-col border-r border-default bg-surface-inset md:flex">
        <div className="p-3">
          <Button
            variant="outline"
            size="sm"
            className="w-full justify-start gap-2"
            render={<Link href={`${basePath}/agent`} />}
          >
            <Plus className="size-4" aria-hidden="true" />
            New chat
          </Button>
        </div>
        <ScrollArea className="min-h-0 flex-1 px-2 pb-2">
          <ul className="flex flex-col gap-1">
            {conversations.length === 0 && (
              <li className="px-2 py-6 text-center text-sm text-text-subtle">No conversations yet</li>
            )}
            {conversations.map((c) => {
              const active = c.id === activeConversationId
              return (
                <li key={c.id}>
                  <Link
                    href={`${basePath}/agent?c=${c.id}`}
                    className={`block truncate rounded-lg px-3 py-2 text-sm transition-colors ${
                      active
                        ? "bg-surface-interactive text-text-primary"
                        : "text-text-secondary hover:bg-surface-interactive-hover hover:text-text-primary"
                    }`}
                  >
                    {c.title || "Untitled chat"}
                  </Link>
                </li>
              )
            })}
          </ul>
        </ScrollArea>
      </aside>

      {/* Thread + composer */}
      <div className="flex min-h-0 flex-1 flex-col">
        <ScrollArea className="min-h-0 flex-1">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4 sm:p-6">
            {messages.length === 0 && !isStreaming && (
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
              <MessageRow key={m.id} role={m.role} content={m.content} userInitials={userInitials} />
            ))}

            {isStreaming && (
              <MessageRow role="assistant" content={streamingText} userInitials={userInitials} status={statusLabel} />
            )}

            {error && (
              <div className="rounded-lg border border-default bg-status-danger-surface px-4 py-3 text-sm text-status-danger">
                {error}
              </div>
            )}
            <div ref={bottomRef} />
          </div>
        </ScrollArea>

        <div className="border-t border-default bg-surface-panel p-3 sm:p-4">
          <div className="mx-auto flex w-full max-w-3xl items-end gap-2">
            <Textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault()
                  void send()
                }
              }}
              placeholder="Message the agent…  (Enter to send, Shift+Enter for newline)"
              rows={1}
              disabled={isStreaming}
              className="max-h-40 flex-1"
            />
            <Button
              size="icon"
              onClick={() => void send()}
              disabled={isStreaming || !input.trim()}
              aria-label="Send message"
            >
              <Send className="size-4" aria-hidden="true" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

function MessageRow({
  role,
  content,
  userInitials,
  status,
}: {
  role: Role
  content: string
  userInitials: string
  status?: string | null
}) {
  const isUser = role === "user"
  return (
    <div className={`flex gap-3 ${isUser ? "flex-row-reverse" : "flex-row"}`}>
      <Avatar className="size-7 shrink-0">
        <AvatarFallback className={isUser ? "bg-surface-interactive text-text-secondary" : "bg-primary text-primary-foreground"}>
          {isUser ? userInitials : <Sparkles className="size-4" aria-hidden="true" />}
        </AvatarFallback>
      </Avatar>
      <div
        className={`min-w-0 max-w-[85%] rounded-xl px-4 py-2.5 text-sm ${
          isUser
            ? "bg-primary text-primary-foreground"
            : "border border-default bg-surface-card text-text-primary"
        }`}
      >
        {status && (
          <div className="mb-1 flex items-center gap-1.5 text-xs text-text-subtle">
            <Wrench className="size-3 animate-pulse" aria-hidden="true" />
            {status}
          </div>
        )}
        {content ? (
          <p className="whitespace-pre-wrap break-words">{content}</p>
        ) : (
          !status && <p className="text-text-subtle">…</p>
        )}
      </div>
    </div>
  )
}
