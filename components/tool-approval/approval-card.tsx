"use client"

// The inline card the in-app agent chat shows when a tool call came back APPROVAL_REQUIRED. It is keyed by request id only:
// the server action returns the STORED request (never agent text), so what an admin approves here is what the page shows.

import { Component, useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import Link from "next/link"
import { ShieldCheck } from "lucide-react"
import type { ApprovalCardData } from "@/app/[orgSlug]/[workspaceSlug]/approvals/actions"
import { ApprovalActions } from "@/components/tool-approval/approval-actions"
import { ApprovalStateBadge } from "@/components/tool-approval/approval-state-badge"
import { EffectDiff } from "@/components/tool-approval/effect-diff"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { CARD_ARGS_CHARS, previewJson, reviewableInCard } from "@/lib/tool-approval/diff"
import { APPROVAL_STATES } from "@/lib/tool-approval/state"

// Loaded on first use, not at import: the chat bundle (and every test that mounts it) must not pull in the server-side auth and
// database modules just because a transcript could one day contain an approval.
const loadActions = () => import("@/app/[orgSlug]/[workspaceSlug]/approvals/actions")

const POLL_MS = 4000
const MAX_POLL_MS = 30_000
const NON_ADMIN_REASON = "Only a workspace admin can approve or deny this. An admin can decide it from Tool approvals."
const linkClass = "inline-flex min-h-11 items-center text-xs font-medium text-primary underline sm:min-h-0"

/** Draws `fallback` instead of nothing when anything below throws (a packet shape the renderer did not expect). */
class CardBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch(error: unknown) { console.error("Tool approval card failed to render", { error: error instanceof Error ? error.name : "unknown" }) }
  render() { return this.state.failed ? this.props.fallback : this.props.children }
}

function Fallback({ message, href, linkLabel }: { message: string; href?: string; linkLabel: string }) {
  return (
    <section aria-label="Tool approval" data-testid="tool-approval-card-fallback" className="min-w-0 max-w-full space-y-1 rounded-lg border border-default bg-surface-card p-3 text-xs text-text-secondary">
      <p className="m-0">{message}</p>
      {href && <Link href={href} className={linkClass}>{linkLabel}</Link>}
    </section>
  )
}

function CardBody({ data, actions }: { data: ApprovalCardData; actions: ReactNode }) {
  const { view, canDecide, effectWithheld } = data
  const review = effectWithheld ? ({ ok: true } as const) : reviewableInCard(view.before, view.after, view.args)
  const args = effectWithheld ? null : previewJson(view.args, CARD_ARGS_CHARS, { pretty: true })
  return (
    <>
      {!effectWithheld && <EffectDiff before={view.before} after={view.after} compact moreHref={view.path} />}
      {args && (
        <Collapsible className="min-w-0 rounded-md border border-default text-xs">
          <CollapsibleTrigger className="flex min-h-11 w-full cursor-pointer items-center px-2 text-left text-text-secondary sm:min-h-8">Call arguments</CollapsibleTrigger>
          <CollapsibleContent>
            <pre className="m-0 max-h-48 min-w-0 overflow-auto px-2 pb-2 font-mono break-words whitespace-pre-wrap [overflow-wrap:anywhere]">{args.text}</pre>
          </CollapsibleContent>
        </Collapsible>
      )}
      <p className="m-0 text-xs text-text-subtle">{view.state.explanation}</p>
      {canDecide && view.state.key === "PENDING" && !review.ok && (
        <div className="flex min-w-0 flex-col gap-1">
          <p data-testid="approval-review-reason" className="m-0 text-xs text-status-warning">{review.reason} Approve stays off until the full request has been reviewed.</p>
          <Link data-testid="approval-review-link" href={view.path} className={linkClass}>Review the full details</Link>
        </div>
      )}
      {actions}
      {canDecide && view.path && review.ok && <Link href={view.path} className={linkClass}>Open the full approval page</Link>}
    </>
  )
}

export function ToolApprovalCard({ workspaceId, requestId, conversationId, approvalsHref }: { workspaceId: string; requestId: string; conversationId: string | null; approvalsHref?: string }) {
  const [data, setData] = useState<ApprovalCardData | null | undefined>(undefined)
  const [failed, setFailed] = useState(false)
  const mounted = useRef(true)
  const terminal = useRef(false)
  const kick = useRef<() => void>(() => undefined)

  const fetchOnce = useCallback(async (): Promise<{ failed: boolean; terminal: boolean; sig: string }> => {
    try {
      const next = await (await loadActions()).getApprovalCardAction({ workspaceId, requestId, conversationId })
      if (!mounted.current) return { failed: false, terminal: true, sig: "" }
      setFailed(false)
      setData(next)
      terminal.current = next ? next.view.state.terminal : true
      return { failed: false, terminal: terminal.current, sig: next ? `${next.view.state.key}|${next.view.receipt?.status ?? ""}` : "none" }
    } catch {
      if (mounted.current) setFailed(true)
      return { failed: true, terminal: false, sig: "" }
    }
  }, [workspaceId, requestId, conversationId])

  // Poll until the approval is final. Waits longer while nothing changes (4s, 8s, 16s, 30s, with +/-20% jitter so open tabs do
  // not synchronise), pauses while the tab is hidden, and refreshes at once when it comes back.
  useEffect(() => {
    mounted.current = true
    terminal.current = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let busy = false
    let misses = 0
    let lastSig: string | null = null
    const tick = async (ignoreHidden: boolean) => {
      timer = undefined
      if (!mounted.current || terminal.current || busy) return
      if (document.hidden && !ignoreHidden) return // resumed by the visibilitychange listener
      busy = true
      const result = await fetchOnce()
      busy = false
      if (!mounted.current || result.terminal) return
      misses = result.failed || result.sig === lastSig ? misses + 1 : 0
      if (!result.failed) lastSig = result.sig
      timer = setTimeout(() => void tick(false), Math.min(MAX_POLL_MS, POLL_MS * 2 ** misses) * (0.8 + 0.4 * Math.random()))
    }
    const refreshNow = () => {
      if (!mounted.current || terminal.current || busy) return
      clearTimeout(timer)
      misses = 0
      void tick(true)
    }
    kick.current = refreshNow
    const onVisible = () => { if (!document.hidden) refreshNow() }
    document.addEventListener("visibilitychange", onVisible)
    void tick(true)
    return () => {
      mounted.current = false
      clearTimeout(timer)
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [fetchOnce])

  if (data === undefined && !failed) return <div data-testid="tool-approval-card-loading" className="h-16 animate-pulse rounded-lg border border-default bg-surface-inset" aria-label="Loading approval" />
  if (!data) {
    // null from the server means "not yours / not a real request": draw nothing. A failure to ask is different: say so.
    if (data === null) return null
    return <Fallback message="Could not load this approval." href={approvalsHref} linkLabel="Open Tool approvals" />
  }
  const { view, canDecide } = data
  const pending = view.state.key === "PENDING"
  const label = `Tool approval ${view.displayId ?? view.requestId.slice(0, 8)}`
  const announcement = pending ? undefined : `${view.displayId ?? "Tool approval"}: ${APPROVAL_STATES[view.state.key].label}. ${view.state.explanation}`
  return (
    <section aria-label={label} data-testid="tool-approval-card" data-state={view.state.key} className="min-w-0 max-w-full space-y-2 rounded-lg border border-default bg-surface-card p-3">
      <header className="flex min-w-0 flex-wrap items-center gap-2">
        <ShieldCheck className="size-4 shrink-0 text-text-subtle" aria-hidden="true" />
        <h3 className="m-0 min-w-0 flex-1 text-sm font-medium break-words text-text-primary [overflow-wrap:anywhere]">{view.title}</h3>
        <ApprovalStateBadge state={view.state.key} />
      </header>
      {view.displayId && <p className="m-0 text-xs text-text-subtle">{view.displayId}</p>}
      {view.summary && <p className="m-0 text-xs break-words text-text-secondary [overflow-wrap:anywhere]">{view.summary}</p>}
      <CardBoundary fallback={<Fallback message="Could not render this approval here. Open the full approval page to review it." href={canDecide ? view.path || approvalsHref : approvalsHref} linkLabel="Open the full approval page" />}>
        <CardBody
          data={data}
          actions={
            <ApprovalActions
              compact
              resolved={!pending}
              announcement={announcement}
              disabledReason={canDecide ? undefined : NON_ADMIN_REASON}
              approveDisabled={canDecide && pending && !data.effectWithheld && !reviewableInCardSafe(data)}
              onDecided={() => kick.current()}
              decide={async (action, key) => (await loadActions()).decideApprovalFromChatAction({ workspaceId, requestId, conversationId }, action, key)}
            />
          }
        />
      </CardBoundary>
    </section>
  )
}

/** Same check CardBody shows the reason for; a throw here (a packet the renderer cannot read) holds Approve back too. */
function reviewableInCardSafe(data: ApprovalCardData): boolean {
  try { return reviewableInCard(data.view.before, data.view.after, data.view.args).ok } catch { return false }
}
