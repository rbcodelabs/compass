"use client"

// Who is in this agent conversation, and the controls to change that.
//
// A conversation starts private to its owner. Anyone in it can invite another
// workspace member (there is no cap), the owner can remove anyone, and a
// participant can leave. The rules are enforced server-side in
// lib/agent-conversation-participants.ts; this component only presents them, so a
// button that is hidden here is a courtesy, never the guard.
//
// It owns the roster fetch and reports it upward (`onRoster`) because the chat
// needs it too: to decide whether to label message authors, to name whoever
// started a run, and to show Stop only to the people allowed to use it.

import { useCallback, useEffect, useRef, useState } from "react"
import { Loader2, UserPlus, Users } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"

export type RosterEntry = {
  userId: string
  role: "OWNER" | "PARTICIPANT"
  name: string
  addedByUserId: string | null
}

export type Roster = {
  available: boolean
  viewerRole: "OWNER" | "PARTICIPANT"
  participants: RosterEntry[]
  candidates?: { userId: string; name: string }[]
  shareable: boolean
}

type Props = {
  conversationId: string
  workspaceId: string
  /** The signed-in user, to tell "leave" from "remove". */
  userId: string
  compact?: boolean
  onRoster: (roster: Roster | null) => void
  /** The server no longer recognises this conversation for this user (404). */
  onAccessLost: (reason: "left" | "removed") => void
}

const ROSTER_POLL_MS = 10_000

export function AgentParticipantsPanel({ conversationId, workspaceId, userId, compact, onRoster, onAccessLost }: Props) {
  const [roster, setRoster] = useState<Roster | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pick, setPick] = useState("")
  // Through refs so an inline arrow from the parent cannot restart the poll.
  const onRosterRef = useRef(onRoster)
  const onAccessLostRef = useRef(onAccessLost)
  const openRef = useRef(open)
  useEffect(() => {
    onRosterRef.current = onRoster
    onAccessLostRef.current = onAccessLost
    openRef.current = open
  }, [onRoster, onAccessLost, open])

  const query = `workspaceId=${encodeURIComponent(workspaceId)}`
  const base = `/api/agent/conversations/${conversationId}/participants`

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const res = await fetch(`${base}?${query}${openRef.current ? "&candidates=1" : ""}`, { signal })
        if (signal?.aborted) return
        if (res.status === 404) {
          onAccessLostRef.current("removed")
          return
        }
        if (!res.ok) return
        const next = (await res.json()) as Roster
        // Anything that is not a roster is ignored rather than trusted: the chat
        // reads `participants` unconditionally, and a proxy error page or an older
        // server must degrade to "not shared", never to a crash.
        if (!next || typeof next.available !== "boolean" || !Array.isArray(next.participants)) return
        setRoster(next)
        onRosterRef.current(next)
      } catch {
        // A failed refresh leaves the last roster on screen; the chat itself does
        // not depend on this panel.
      }
    },
    [base, query],
  )

  useEffect(() => {
    setRoster(null)
    setOpen(false)
    setError(null)
    onRosterRef.current(null)
    const controller = new AbortController()
    void load(controller.signal)
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load(controller.signal)
    }, ROSTER_POLL_MS)
    return () => {
      controller.abort()
      clearInterval(timer)
    }
  }, [load])

  // Candidates are only fetched while the panel is open, so opening it reloads.
  useEffect(() => {
    if (open) void load()
  }, [open, load])

  async function mutate(request: () => Promise<Response>, after?: () => void) {
    setBusy(true)
    setError(null)
    try {
      const res = await request()
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null
        setError(body?.error ?? `Request failed (${res.status}).`)
        return
      }
      after?.()
      await load()
    } catch {
      setError("Could not reach the server.")
    } finally {
      setBusy(false)
    }
  }

  // Not shown before the migration, or for a conversation that can never be shared.
  if (!roster || !roster.available || !roster.shareable) return null

  const isOwner = roster.viewerRole === "OWNER"
  const others = roster.participants.length - 1

  return (
    <div className="border-b border-default bg-surface-inset text-sm">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={`flex w-full items-center gap-2 text-left text-text-secondary hover:text-text-primary ${compact ? "px-3 py-1.5" : "px-4 py-2"}`}
      >
        <Users className="size-4 shrink-0" aria-hidden="true" />
        <span className="truncate">
          {others === 0 ? "Only you" : `Shared with ${others} ${others === 1 ? "person" : "people"}`}
        </span>
        <span className="ml-auto text-xs text-text-subtle">{open ? "Hide" : others === 0 ? "Invite" : "Manage"}</span>
      </button>

      {open && (
        <div className={`flex flex-col gap-3 border-t border-default ${compact ? "p-3" : "p-4"}`}>
          <p className="text-xs text-text-subtle">
            Everyone in this conversation can read all of it, including what the agent reads and replies with
            for any participant. Invite only people who should see that.
          </p>

          <ul className="flex flex-col gap-1.5" aria-label="Participants">
            {roster.participants.map((p) => {
              const isSelf = p.userId === userId
              return (
                <li key={p.userId} className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate">
                    {p.name}
                    {isSelf && <span className="text-text-subtle"> (you)</span>}
                  </span>
                  {p.role === "OWNER" && <Badge variant="secondary">Owner</Badge>}
                  {p.role !== "OWNER" && isSelf && (
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        void mutate(
                          () => fetch(`${base}/${p.userId}?${query}`, { method: "DELETE" }),
                          () => onAccessLostRef.current("left"),
                        )
                      }
                    >
                      Leave
                    </Button>
                  )}
                  {p.role !== "OWNER" && !isSelf && isOwner && (
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={busy}
                      aria-label={`Remove ${p.name}`}
                      onClick={() => void mutate(() => fetch(`${base}/${p.userId}?${query}`, { method: "DELETE" }))}
                    >
                      Remove
                    </Button>
                  )}
                </li>
              )
            })}
          </ul>

          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              if (!pick) return
              void mutate(
                () =>
                  fetch(`${base}?${query}`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ userId: pick }),
                  }),
                () => setPick(""),
              )
            }}
          >
            <label className="sr-only" htmlFor={`invite-${conversationId}`}>
              Invite a workspace member
            </label>
            <select
              id={`invite-${conversationId}`}
              value={pick}
              onChange={(e) => setPick(e.target.value)}
              disabled={busy || !roster.candidates?.length}
              className="h-8 min-w-0 flex-1 rounded-lg border border-default bg-surface-panel px-2 text-sm text-text-primary"
            >
              <option value="">
                {roster.candidates === undefined
                  ? "Loading…"
                  : roster.candidates.length
                    ? "Invite a workspace member…"
                    : "Everyone in the workspace is already here"}
              </option>
              {roster.candidates?.map((c) => (
                <option key={c.userId} value={c.userId}>
                  {c.name}
                </option>
              ))}
            </select>
            <Button type="submit" size="sm" disabled={busy || !pick} className="gap-1">
              {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : <UserPlus className="size-3.5" aria-hidden="true" />}
              Invite
            </Button>
          </form>

          {error && (
            <p role="alert" className="text-xs text-status-danger">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
