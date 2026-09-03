"use client"

import Link from "next/link"
import { useState, useTransition } from "react"
import { requestNowCommitmentAction } from "@/app/[orgSlug]/[workspaceSlug]/reviews/actions"

export function NowCommitmentCard({ itemId, workspaceId, orgSlug, workspaceSlug, horizon, review, provenance, decisionRecordId, application }: {
  itemId: string
  workspaceId: string
  orgSlug: string
  workspaceSlug: string
  horizon: string
  review: { id: string; state: string } | null
  provenance: string
  decisionRecordId: string | null
  application: { id: string; status: string; receiptKey: string } | null
}) {
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const reviewHref = review ? `/${orgSlug}/${workspaceSlug}/reviews/${review.id}` : null
  const reviewState = review?.state
  if (horizon === "NOW") {
    return (
      <div className="space-y-1 text-sm">
        <p>This item is in NOW with <strong>{provenance === "NATIVE_GATED" ? "native decision provenance" : "legacy ungated provenance"}</strong>.</p>
        {decisionRecordId && reviewHref && <Link className="block font-medium text-primary underline" href={reviewHref}>Decision record: {decisionRecordId}</Link>}
        {application && <p>Application receipt: <span className="font-mono">{application.receiptKey}</span> ({application.status})</p>}
      </div>
    )
  }
  if (reviewHref && reviewState !== "SUPERSEDED" && reviewState !== "EXPIRED" && reviewState !== "CANCELLED") {
    return <Link className="text-sm font-medium text-primary underline" href={reviewHref}>Open {reviewState?.toLowerCase()} commitment review</Link>
  }
  return (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground">{review ? "The prior review is no longer actionable. Prepare a new immutable revision." : "Entering NOW requires an immutable admin decision."}</p>
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
