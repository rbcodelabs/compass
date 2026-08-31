"use client"

import Link from "next/link"
import { useState, useTransition } from "react"
import { requestNowCommitmentAction } from "@/app/[orgSlug]/[workspaceSlug]/reviews/actions"

export function NowCommitmentCard({ itemId, workspaceId, orgSlug, workspaceSlug, horizon, review }: {
  itemId: string
  workspaceId: string
  orgSlug: string
  workspaceSlug: string
  horizon: string
  review: { id: string; state: string } | null
}) {
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const reviewHref = review ? `/${orgSlug}/${workspaceSlug}/reviews/${review.id}` : null
  const reviewState = review?.state
  if (horizon === "NOW") {
    return <p className="text-sm text-muted-foreground">This item is already in NOW.</p>
  }
  if (reviewHref) {
    return <Link className="text-sm font-medium text-primary underline" href={reviewHref}>Open {reviewState?.toLowerCase()} commitment review</Link>
  }
  return (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground">Entering NOW requires an immutable admin decision.</p>
      <button
        className="rounded-md border px-3 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
        disabled={pending}
        onClick={() => startTransition(async () => {
          setError(null)
          try {
            const result = await requestNowCommitmentAction(workspaceId, itemId)
            window.location.assign(`/${orgSlug}/${workspaceSlug}/reviews/${result.requestId}`)
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : "Could not prepare review")
          }
        })}
      >
        {pending ? "Preparing…" : "Request NOW commitment"}
      </button>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  )
}
