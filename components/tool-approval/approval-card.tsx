"use client"

// The inline card the in-app agent chat shows when a tool call came back APPROVAL_REQUIRED. It is keyed by request id only:
// the server action returns the STORED request (never agent text), so what an admin approves here is what the page shows.

import { useCallback, useEffect, useState } from "react"
import { ShieldCheck } from "lucide-react"
import type { ApprovalCardData } from "@/app/[orgSlug]/[workspaceSlug]/approvals/actions"
import { ApprovalActions } from "@/components/tool-approval/approval-actions"
import { ApprovalStateBadge } from "@/components/tool-approval/approval-state-badge"
import { EffectDiff } from "@/components/tool-approval/effect-diff"
import type { ApprovalActionResult } from "@/lib/tool-approval/messages"

// Loaded on first use, not at import: the chat bundle (and every test that mounts it) must not pull in the server-side auth and
// database modules just because a transcript could one day contain an approval.
const loadActions = () => import("@/app/[orgSlug]/[workspaceSlug]/approvals/actions")

const POLL_MS = 4000
const NON_ADMIN_REASON = "Only a workspace admin can approve or deny this. An admin can decide it from Tool approvals."

export function ToolApprovalCard({ workspaceId, requestId, conversationId }: { workspaceId: string; requestId: string; conversationId: string | null }) {
  const [data, setData] = useState<ApprovalCardData | null | undefined>(undefined)
  // What the click reported. Kept here, not in the buttons, because the buttons disappear once the approval is no longer pending.
  const [note, setNote] = useState<ApprovalActionResult | null>(null)

  const load = useCallback(async () => {
    try { setData(await (await loadActions()).getApprovalCardAction({ workspaceId, requestId })) } catch { setData((current) => current ?? null) }
  }, [workspaceId, requestId])

  useEffect(() => { void load() }, [load])
  const terminal = data ? data.view.state.terminal : false
  useEffect(() => {
    if (data === null || terminal) return
    const timer = setInterval(() => void load(), POLL_MS)
    return () => clearInterval(timer)
  }, [data, terminal, load])

  if (data === undefined) return <div data-testid="tool-approval-card-loading" className="h-16 animate-pulse rounded-lg border border-default bg-surface-inset" aria-label="Loading approval" />
  if (data === null) return null
  const { view, canDecide, effectWithheld } = data
  const pending = view.state.key === "PENDING"
  return (
    <section aria-label="Tool approval" data-testid="tool-approval-card" data-state={view.state.key} className="min-w-0 max-w-full space-y-2 rounded-lg border border-default bg-surface-card p-3">
      <header className="flex min-w-0 flex-wrap items-center gap-2">
        <ShieldCheck className="size-4 shrink-0 text-text-subtle" aria-hidden="true" />
        <h3 className="m-0 min-w-0 flex-1 text-sm font-medium break-words text-text-primary [overflow-wrap:anywhere]">{view.title}</h3>
        <ApprovalStateBadge state={view.state.key} />
      </header>
      {view.displayId && <p className="m-0 text-xs text-text-subtle">{view.displayId}</p>}
      {view.summary && <p className="m-0 text-xs break-words text-text-secondary [overflow-wrap:anywhere]">{view.summary}</p>}
      {!effectWithheld && <EffectDiff before={view.before} after={view.after} compact moreHref={view.path} />}
      <p className="m-0 text-xs text-text-subtle">{view.state.explanation}</p>
      {pending && <ApprovalActions compact disabledReason={canDecide ? undefined : NON_ADMIN_REASON} onDecided={(result) => { setNote(result); void load() }} decide={async (action, key) => (await loadActions()).decideApprovalFromChatAction({ workspaceId, requestId, conversationId }, action, key)} />}
      {note && !pending && <p role="status" data-testid="approval-card-note" className="m-0 text-xs break-words text-text-secondary [overflow-wrap:anywhere]">{note.message}</p>}
      {canDecide && view.path && <a href={view.path} className="inline-flex min-h-11 items-center text-xs font-medium text-primary underline sm:min-h-0">Open the full approval page</a>}
    </section>
  )
}
