"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { Bell, BellRing } from "lucide-react"
import { Button } from "@/components/ui/button"

type State = { available: boolean; following: boolean } | null

/**
 * Follow / Following toggle for a detail view (ADR "Following and in-app
 * notifications", section 2.8). It asks the server for the signed-in user's own
 * state, so it needs no change to any panel's data contract, and it renders
 * nothing at all when following is off or the subject type has not shipped yet.
 * `Following` is a pressed toggle; an unfollow is remembered server-side, so
 * commenting on the object later will not silently follow it again.
 */
export function FollowButton({
  orgSlug,
  workspaceSlug,
  subjectType,
  subjectId,
  className,
}: {
  orgSlug: string
  workspaceSlug: string
  subjectType: string
  subjectId: string
  className?: string
}) {
  const [state, setState] = useState<State>(null)
  const [error, setError] = useState("")
  const [pending, setPending] = useState(false)
  // Drop a response that belongs to a subject the user has already navigated away from.
  const generation = useRef(0)

  const base = { orgSlug, workspaceSlug, subjectType, subjectId }

  useEffect(() => {
    const mine = ++generation.current
    const query = new URLSearchParams(base).toString()
    fetch(`/api/following?${query}`)
      .then((response) => (response.ok ? response.json() : { available: false }))
      .then((data: { available?: boolean; following?: boolean }) => {
        if (mine === generation.current) setState({ available: Boolean(data.available), following: Boolean(data.following) })
      })
      .catch(() => {
        if (mine === generation.current) setState({ available: false, following: false })
      })
    // `base` is rebuilt every render from these four primitives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgSlug, workspaceSlug, subjectType, subjectId])

  const toggle = useCallback(async () => {
    if (!state || pending) return
    const next = !state.following
    setPending(true)
    setError("")
    setState({ ...state, following: next })
    try {
      const response = await fetch("/api/following", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orgSlug, workspaceSlug, subjectType, subjectId, following: next }),
      })
      if (!response.ok) throw new Error("request failed")
    } catch {
      setState({ ...state, following: !next })
      setError(next ? "Could not follow. Try again." : "Could not unfollow. Try again.")
    } finally {
      setPending(false)
    }
  }, [state, pending, orgSlug, workspaceSlug, subjectType, subjectId])

  if (!state?.available) return null
  const Icon = state.following ? BellRing : Bell

  return (
    <span className={`inline-flex items-center gap-2 ${className ?? ""}`}>
      <Button
        type="button"
        variant="outline"
        size="sm"
        aria-pressed={state.following}
        disabled={pending}
        onClick={toggle}
        data-slot="follow-button"
        title={state.following ? "You get notified about status changes and comments. Click to unfollow." : "Get notified about status changes and comments"}
      >
        <Icon className={state.following ? "text-primary" : undefined} aria-hidden="true" />
        {state.following ? "Following" : "Follow"}
      </Button>
      {error && (
        <span role="alert" className="text-xs text-destructive">
          {error}
        </span>
      )}
    </span>
  )
}
