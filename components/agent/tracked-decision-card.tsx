"use client"

/**
 * Chat Option 3 — Inline Quick Card for Tracked Decisions (`request_decision`) in Agent Chat & AgentRail.
 *
 * Security & trust invariants:
 * 1. `requestId` parsed from tool output is used ONLY as a lookup key against `/api/panels/review/[id]`,
 *    which enforces session auth, workspace membership, and `excludeToolApprovals` (never `TOOL_APPROVAL`).
 * 2. Renders live stored question/options/outcome from the database — never agent prose.
 * 3. Server actions are dynamically imported on click so mounting chat transcripts never eagerly bundles server modules.
 */

import { Component, useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { CheckCircle2, CircleDashed, GitPullRequestDraft, PanelRightOpen, RotateCcw, XCircle } from "lucide-react"
import { StatusBadge } from "@/components/patterns/status-badge"
import { Button, buttonVariants } from "@/components/ui/button"
import { useOptionalPanelContext } from "@/components/panels/panel-context"
import type { DecisionPanelData } from "@/components/panels/decision-panel"
import { DECISION_UPDATED_EVENT, decisionStatusBadgeProps, notifyDecisionUpdated, plainTextPreview } from "@/lib/decision-review-ui"
import { cn } from "@/lib/utils"

const loadReviewActions = () => import("@/app/[orgSlug]/[workspaceSlug]/reviews/actions")

const POLL_MS = 4000
const MAX_POLL_MS = 30_000

class CardBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch(error: unknown) {
    console.error("Tracked decision chat card failed to render", { error: error instanceof Error ? error.name : "unknown" })
  }
  render() { return this.state.failed ? this.props.fallback : this.props.children }
}

function CardFallback({ message, href, linkLabel }: { message: string; href?: string; linkLabel: string }) {
  return (
    <section
      aria-label="Decision request"
      data-testid="tracked-decision-card-fallback"
      className="min-w-0 max-w-full space-y-1.5 rounded-lg border border-border-default bg-surface-card p-3 text-xs text-text-secondary"
    >
      <p className="m-0">{message}</p>
      {href && (
        <Link href={href} className="inline-flex items-center font-medium text-primary underline">
          {linkLabel}
        </Link>
      )}
    </section>
  )
}

function OutcomeMiniIcon({ outcomeClass }: { outcomeClass: string }) {
  if (outcomeClass === "APPROVE") return <CheckCircle2 className="size-3.5 shrink-0 text-status-success" aria-hidden="true" />
  if (outcomeClass === "REQUEST_CHANGES") return <RotateCcw className="size-3.5 shrink-0 text-status-warning" aria-hidden="true" />
  if (outcomeClass === "REJECT") return <XCircle className="size-3.5 shrink-0 text-status-danger" aria-hidden="true" />
  return <GitPullRequestDraft className="size-3.5 shrink-0 text-text-subtle" aria-hidden="true" />
}

export function TrackedDecisionChatCard({
  requestId,
  basePath,
}: {
  requestId: string
  /** `/org/workspace`, supplied by AgentChat/AgentActivity. Falls back to PanelContext when omitted. */
  basePath?: string
}) {
  const panelCtx = useOptionalPanelContext()
  const router = useRouter()
  const segments = basePath ? basePath.split("/").filter(Boolean) : []
  const orgSlug = segments[0] ?? panelCtx?.orgSlug ?? ""
  const workspaceSlug = segments[1] ?? panelCtx?.workspaceSlug ?? ""

  const [data, setData] = useState<DecisionPanelData | null | undefined>(undefined)
  const [failed, setFailed] = useState(false)
  const [selectedChoiceId, setSelectedChoiceId] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  const mounted = useRef(true)
  const terminal = useRef(false)
  const refreshRef = useRef<() => void>(() => undefined)

  const fetchOnce = useCallback(async (): Promise<{ failed: boolean; terminal: boolean; sig: string }> => {
    if (!orgSlug || !workspaceSlug) return { failed: false, terminal: true, sig: "unscoped" }
    try {
      const res = await fetch(
        `/api/panels/review/${encodeURIComponent(requestId)}?orgSlug=${encodeURIComponent(orgSlug)}&workspaceSlug=${encodeURIComponent(workspaceSlug)}`,
      )
      if (!mounted.current) return { failed: false, terminal: true, sig: "" }
      if (res.status === 404 || res.status === 401 || res.status === 403) {
        setFailed(false)
        setData(null)
        terminal.current = true
        return { failed: false, terminal: true, sig: "none" }
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = (await res.json()) as { data?: DecisionPanelData }
      const next = json.data ?? null
      if (!mounted.current) return { failed: false, terminal: true, sig: "" }
      setFailed(false)
      setData(next)
      const isDone = !next || Boolean(next.decision) || next.state !== "PENDING" || next.stale || next.readOnlyLegacy
      terminal.current = isDone
      return {
        failed: false,
        terminal: isDone,
        sig: next ? `${next.state}|${next.revisionId}|${next.decision?.outcomeClass ?? ""}` : "none",
      }
    } catch {
      if (mounted.current) setFailed(true)
      return { failed: true, terminal: false, sig: "" }
    }
  }, [requestId, orgSlug, workspaceSlug])

  useEffect(() => {
    if (!orgSlug || !workspaceSlug) return
    mounted.current = true
    terminal.current = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let busy = false
    let misses = 0
    let lastSig: string | null = null

    const tick = async (ignoreHidden: boolean) => {
      timer = undefined
      if (!mounted.current || busy) return
      if (document.hidden && !ignoreHidden) return
      busy = true
      const result = await fetchOnce()
      busy = false
      if (!mounted.current || result.terminal) return
      misses = result.failed || result.sig === lastSig ? misses + 1 : 0
      if (!result.failed) lastSig = result.sig
      timer = setTimeout(() => void tick(false), Math.min(MAX_POLL_MS, POLL_MS * 2 ** misses) * (0.8 + 0.4 * Math.random()))
    }

    const refreshNow = () => {
      if (!mounted.current || busy) return
      clearTimeout(timer)
      misses = 0
      terminal.current = false
      void tick(true)
    }
    refreshRef.current = refreshNow

    const onVisible = () => {
      if (!document.hidden && !terminal.current) refreshNow()
    }
    const onDecisionUpdated = () => refreshNow()

    document.addEventListener("visibilitychange", onVisible)
    window.addEventListener(DECISION_UPDATED_EVENT, onDecisionUpdated)
    void tick(true)

    return () => {
      mounted.current = false
      clearTimeout(timer)
      document.removeEventListener("visibilitychange", onVisible)
      window.removeEventListener(DECISION_UPDATED_EVENT, onDecisionUpdated)
    }
  }, [fetchOnce, orgSlug, workspaceSlug])

  if (!orgSlug || !workspaceSlug) return null
  const resolvedBase = `/${orgSlug}/${workspaceSlug}`
  const decisionsHref = `${resolvedBase}/decisions`

  if (data === undefined && !failed) {
    return (
      <div
        data-testid="tracked-decision-card-loading"
        aria-label="Loading decision"
        className="h-20 animate-pulse rounded-xl border border-border-default bg-surface-inset"
      />
    )
  }

  if (!data) {
    if (data === null) return null
    return <CardFallback message="Could not load this decision request." href={decisionsHref} linkLabel="Open Decisions" />
  }

  const fullPageHref = `${resolvedBase}/reviews/${data.displayId ?? data.id}`
  const badge = decisionStatusBadgeProps({
    state: data.state,
    outcomeClass: data.decision?.outcomeClass ?? null,
    outcomeLabel: data.decision?.label ?? null,
    stale: data.stale,
    readOnlyLegacy: data.readOnlyLegacy,
  })
  const excerpt = plainTextPreview(data.context ?? data.summary, 160)
  const isActionable = data.state === "PENDING" && data.isTracked && data.canDecide && !data.stale && !data.readOnlyLegacy
  const approveOption = data.options.find((option) => option.outcomeClass === "APPROVE")
  const hasChoices = data.offeredChoices.length > 0
  const hasQuestions = data.questions.length > 0

  async function quickDecide(optionId: string) {
    if (!data || submitting) return
    setSubmitting(true)
    setActionError(null)
    try {
      const { decideReviewAction } = await loadReviewActions()
      await decideReviewAction({
        workspaceId: data.workspaceId,
        revisionId: data.revisionId,
        fingerprint: data.fingerprint,
        optionId,
        rationale: "",
      })
      notifyDecisionUpdated(data.revisionId)
      router.refresh()
      refreshRef.current()
    } catch (cause) {
      if (mounted.current) {
        const raw = cause instanceof Error ? cause.message : "Could not record decision."
        setActionError(
          /Minified React error #441/i.test(raw)
            ? "Could not record decision right now. Please try again or open the decision brief."
            : raw,
        )
        refreshRef.current()
      }
    } finally {
      if (mounted.current) setSubmitting(false)
    }
  }

  const openDrawerControl = (label: string, variant: "default" | "outline" | "ghost" = "outline") => {
    if (panelCtx) {
      return (
        <Button
          type="button"
          size="sm"
          variant={variant}
          onClick={() => panelCtx.openPanel("review", data.id)}
          className="gap-1.5"
        >
          <span>{label}</span>
          <PanelRightOpen className="size-3.5 shrink-0" aria-hidden="true" />
        </Button>
      )
    }
    return (
      <Link href={fullPageHref} className={cn(buttonVariants({ variant, size: "sm" }), "gap-1.5")}>
        <span>{label}</span>
        <PanelRightOpen className="size-3.5 shrink-0" aria-hidden="true" />
      </Link>
    )
  }

  const cardLabel = `Decision ${data.displayId ?? data.id.slice(0, 8)}`

  return (
    <section
      aria-label={cardLabel}
      data-testid="tracked-decision-chat-card"
      data-state={data.decision ? "DECIDED" : data.state}
      className="min-w-0 max-w-full space-y-2.5 rounded-xl border border-border-default bg-surface-card p-3 shadow-xs"
    >
      <CardBoundary
        fallback={
          <CardFallback
            message="Could not render this decision here. Open the decision page to review it."
            href={fullPageHref}
            linkLabel="Open decision page"
          />
        }
      >
        <header className="flex min-w-0 flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs">
            <GitPullRequestDraft className="size-3.5 shrink-0 text-text-subtle" aria-hidden="true" />
            {data.displayId && (
              <span className="rounded bg-surface-inset px-1.5 py-0.5 font-mono text-[11px] font-medium text-text-secondary">
                {data.displayId}
              </span>
            )}
            {data.linkedTo?.title && (
              <span className="max-w-[14rem] truncate text-text-subtle">
                {data.linkedTo.title}
              </span>
            )}
          </div>
          <StatusBadge
            status={badge.status}
            icon={!data.decision && !data.stale && data.state === "PENDING" ? <CircleDashed /> : undefined}
          >
            {badge.label}
          </StatusBadge>
        </header>

        <div className="min-w-0 space-y-1">
          <h3 className="m-0 text-sm font-semibold leading-snug break-words text-text-primary [overflow-wrap:anywhere]">
            {data.title}
          </h3>
          {excerpt && (
            <p className="m-0 line-clamp-2 text-xs leading-relaxed break-words text-text-secondary [overflow-wrap:anywhere]">
              {excerpt}
            </p>
          )}
        </div>

        {data.decision ? (
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-lg border border-border-subtle bg-surface-inset/60 px-2.5 py-2 text-xs">
            <span className="flex min-w-0 items-center gap-1.5 text-text-primary">
              <OutcomeMiniIcon outcomeClass={data.decision.outcomeClass} />
              <span className="min-w-0 break-words [overflow-wrap:anywhere]">
                Decision recorded: <strong>{data.decision.label}</strong>
              </span>
            </span>
            {openDrawerControl("View decision", "ghost")}
          </div>
        ) : isActionable ? (
          hasQuestions ? (
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 border-t border-border-subtle pt-2">
              <span className="text-xs text-text-subtle">
                {data.questions.length} {data.questions.length === 1 ? "question requires" : "questions require"} answers
              </span>
              {openDrawerControl("Answer in drawer", "default")}
            </div>
          ) : hasChoices ? (
            <div className="min-w-0 space-y-2 border-t border-border-subtle pt-2.5">
              <div role="radiogroup" aria-label="Quick choices" className="grid min-w-0 gap-1.5">
                {data.offeredChoices.map((choice) => {
                  const checked = selectedChoiceId === choice.id
                  return (
                    <button
                      key={choice.id}
                      type="button"
                      role="radio"
                      aria-checked={checked}
                      disabled={submitting}
                      onClick={() => {
                        setSelectedChoiceId(choice.id)
                        setActionError(null)
                      }}
                      className={cn(
                        "flex min-w-0 items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left text-xs transition-colors",
                        checked
                          ? "border-primary bg-accent/60 font-medium text-text-primary"
                          : "border-border-default bg-surface-inset/40 text-text-primary hover:bg-surface-hover",
                        submitting && "opacity-60",
                      )}
                    >
                      <span
                        aria-hidden="true"
                        className={cn(
                          "size-3 shrink-0 rounded-full border",
                          checked ? "border-4 border-primary bg-background" : "border-border-strong bg-background",
                        )}
                      />
                      <span className="min-w-0 flex-1 break-words [overflow-wrap:anywhere]">{choice.label}</span>
                    </button>
                  )
                })}
              </div>
              {actionError && <p role="alert" className="m-0 text-xs text-status-danger">{actionError}</p>}
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  disabled={!selectedChoiceId || submitting}
                  onClick={() => selectedChoiceId && void quickDecide(selectedChoiceId)}
                >
                  {submitting ? "Recording…" : "Confirm choice"}
                </Button>
                {openDrawerControl("Read brief & decide", "ghost")}
              </div>
            </div>
          ) : (
            <div className="min-w-0 space-y-1.5 border-t border-border-subtle pt-2">
              {actionError && <p role="alert" className="m-0 text-xs text-status-danger">{actionError}</p>}
              <div className="flex flex-wrap items-center gap-2">
                {approveOption && (
                  <Button
                    type="button"
                    size="sm"
                    disabled={submitting}
                    onClick={() => void quickDecide(approveOption.id)}
                  >
                    {submitting ? "Recording…" : approveOption.label}
                  </Button>
                )}
                {openDrawerControl("Read brief & decide", "outline")}
              </div>
            </div>
          )
        ) : (
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 border-t border-border-subtle pt-2 text-xs text-text-subtle">
            <span>
              {data.stale
                ? "This request is stale and needs a revised packet."
                : "Only a workspace admin can record this decision."}
            </span>
            {openDrawerControl("Read brief", "outline")}
          </div>
        )}
      </CardBoundary>
    </section>
  )
}
