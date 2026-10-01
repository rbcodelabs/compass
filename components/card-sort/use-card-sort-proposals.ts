"use client"

import { useCallback, useState, useTransition } from "react"
import { useRouter } from "next/navigation"

/**
 * The only client-side path to the proposals API.
 *
 * Both card sort views use this hook, so the table's menu, the kanban's menu and
 * the kanban's drag gesture all issue byte-identical requests. That matters
 * beyond tidiness: the whole feature rests on a proposal being a proposal
 * whichever gesture produced it, and three hand-written fetch calls would be
 * three chances for one of them to grow a field the others lack.
 *
 * Note what is NOT here: any endpoint that writes a CustomFieldValue. Proposing
 * and withdrawing are the only two mutations this feature performs. The official
 * value is read-only in this UI, and the way to keep it that way is to give the
 * client no way to say otherwise.
 *
 * `fromValue` is likewise absent from the request body on purpose — the server
 * reads the official value itself (readOfficialValue in lib/card-sort.ts) rather
 * than trusting the client's idea of where the card started. A stale board would
 * otherwise record a move from a bucket the object had already left.
 */
export function useCardSortProposals({
  orgSlug,
  workspaceSlug,
  roundId,
}: {
  orgSlug: string
  workspaceSlug: string
  roundId: string
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const qs = `orgSlug=${encodeURIComponent(orgSlug)}&workspaceSlug=${encodeURIComponent(workspaceSlug)}`

  const call = useCallback(
    async (input: RequestInfo, init: RequestInit) => {
      setBusy(true)
      setError(null)
      try {
        const response = await fetch(input, init)
        const payload = (await response.json().catch(() => ({}))) as {
          error?: string
          skipped?: { reason: string }[]
          applied?: string[]
        }
        if (!response.ok) {
          setError(payload.error ?? `Request failed (${response.status})`)
          return null
        }
        // Partial success on a bulk action is a real outcome, not a failure:
        // selecting twenty rows and proposing "Could Do" will include some that
        // are already there. Say so rather than silently doing less than asked.
        if (payload.skipped?.length) {
          setError(
            `Recorded ${payload.applied?.length ?? 0}. Skipped ${payload.skipped.length}: ${payload.skipped[0].reason}`
          )
        }
        // Re-read server state rather than patching a local copy. The server
        // decides what the caller may see (visibility gating) and what a
        // proposal's fromValue is, so a client-side optimistic update would be
        // guessing at both.
        startTransition(() => router.refresh())
        return payload
      } finally {
        setBusy(false)
      }
    },
    [router]
  )

  const propose = useCallback(
    (objectIds: string[], proposedValue: string) =>
      call(`/api/card-sort/rounds/${roundId}/proposals?${qs}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ objectIds, proposedValue }),
      }),
    [call, qs, roundId]
  )

  const withdraw = useCallback(
    (objectId: string) =>
      call(`/api/card-sort/rounds/${roundId}/proposals?${qs}&objectId=${objectId}`, {
        method: "DELETE",
      }),
    [call, qs, roundId]
  )

  const patchRound = useCallback(
    (state: "REVEALED" | "CLOSED") =>
      call(`/api/card-sort/rounds/${roundId}?${qs}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state }),
      }),
    [call, qs, roundId]
  )

  // New-entry requests (OPPORTUNITY rounds). Same call() so errors, the busy
  // flag and the server-state refresh behave exactly as for move proposals.
  const proposeEntry = useCallback(
    (entry: { title: string; description?: string; suggestedValue?: string }) =>
      call(`/api/card-sort/rounds/${roundId}/new-entries?${qs}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(entry),
      }),
    [call, qs, roundId]
  )

  const withdrawEntry = useCallback(
    (entryId: string) =>
      call(`/api/card-sort/rounds/${roundId}/new-entries?${qs}&entryId=${encodeURIComponent(entryId)}`, {
        method: "DELETE",
      }),
    [call, qs, roundId]
  )

  const resolveEntry = useCallback(
    (entryId: string, action: "accept" | "reject", note?: string) =>
      call(`/api/card-sort/rounds/${roundId}/new-entries?${qs}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entryId, action, note }),
      }),
    [call, qs, roundId]
  )

  return {
    propose,
    withdraw,
    patchRound,
    proposeEntry,
    withdrawEntry,
    resolveEntry,
    error,
    setError,
    working: busy || pending,
  }
}
