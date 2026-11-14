"use client"

/**
 * Dedicated child sub-agent drill-down timeline with a sticky ancestor breadcrumb bar,
 * ported from Geode's `ThreadsView` sub-agent inspection experience into Compass Studio Quiet.
 */

import { Fragment, useMemo, useState } from "react"
import {
  AlertCircle,
  ArrowLeft,
  Check,
  CheckCircle2,
  ChevronRight,
  Circle,
  Loader2,
  MessageSquare,
  Network,
  Wrench,
} from "lucide-react"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Markdown } from "@/components/agent/markdown"
import type { StepStatus, ToolStep } from "@/lib/agent-run-stream"
import { formatRelativeTime } from "@/lib/agent-board"
import {
  agentLabel,
  agentSubLabel,
  buildAgentBreadcrumbs,
  formatChildAgentStatus,
  listDirectChildRuns,
  type ChildAgentStatus,
  type SerializedChildAgentRun,
} from "@/lib/agent/child-agent-tree"
import { cn } from "@/lib/utils"

type ChildAgentTimelineProps = {
  run: SerializedChildAgentRun
  allRuns: readonly SerializedChildAgentRun[]
  onSelectChildRun: (childRunId: string | null) => void
  compact?: boolean
}

const STATUS_BADGE_CLASS: Record<ChildAgentStatus, string> = {
  RUNNING: "bg-status-info-surface text-status-info",
  SUCCEEDED: "bg-status-success-surface text-status-success",
  FAILED: "bg-status-danger-surface text-status-danger",
  INTERRUPTED: "bg-status-neutral-surface text-status-neutral",
}

function StatusGlyph({ status }: { status: ChildAgentStatus }) {
  switch (status) {
    case "RUNNING":
      return <Loader2 aria-hidden="true" className="size-4 shrink-0 text-status-info motion-safe:animate-spin" />
    case "SUCCEEDED":
      return <CheckCircle2 aria-hidden="true" className="size-4 shrink-0 text-status-success" />
    case "FAILED":
      return <AlertCircle aria-hidden="true" className="size-4 shrink-0 text-status-danger" />
    case "INTERRUPTED":
      return <Circle aria-hidden="true" className="size-4 shrink-0 text-text-subtle" />
  }
}

function StepIcon({ status }: { status: StepStatus }) {
  if (status === "running") {
    return <Loader2 aria-label="Running" className="size-3.5 shrink-0 text-status-info motion-safe:animate-spin" />
  }
  if (status === "error") {
    return <AlertCircle aria-label="Failed" className="size-3.5 shrink-0 text-status-danger" />
  }
  return <Check aria-label="Done" className="size-3.5 shrink-0 text-status-success" />
}

function TimelineStepRow({ step, defaultOpen = false }: { step: ToolStep; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  const expandable = Boolean(step.detail || step.result)
  const header = (
    <>
      <StepIcon status={step.status} />
      <span className="font-medium text-text-primary">{step.label}</span>
      {step.detail && (
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-text-subtle">{step.detail}</span>
      )}
      {expandable && (
        <ChevronRight
          aria-hidden="true"
          className={cn("ml-auto size-3.5 shrink-0 text-text-subtle transition-transform", open && "rotate-90")}
        />
      )}
    </>
  )

  return (
    <li className="rounded-lg border border-border-default bg-surface-card text-xs">
      {expandable ? (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((prev) => !prev)}
          className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left transition-colors hover:bg-surface-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          {header}
        </button>
      ) : (
        <div className="flex items-center gap-2 px-3 py-2">{header}</div>
      )}
      {open && expandable && (
        <div className="space-y-1.5 border-t border-border-default bg-surface-inset px-3 py-2 font-mono text-[11px] leading-relaxed break-words whitespace-pre-wrap">
          {step.detail && <p className="text-text-secondary">{step.detail}</p>}
          {step.result && (
            <p className={step.status === "error" ? "text-status-danger" : "text-text-primary"}>{step.result}</p>
          )}
        </div>
      )}
    </li>
  )
}

export function ChildAgentTimeline({ run, allRuns, onSelectChildRun, compact = false }: ChildAgentTimelineProps) {
  const breadcrumbs = useMemo(() => buildAgentBreadcrumbs(allRuns, run.id), [allRuns, run.id])
  const directChildren = useMemo(() => listDirectChildRuns(allRuns, run.id), [allRuns, run.id])
  const primaryName = agentLabel(run)
  const stepCount = Math.max(run.stepCount, run.steps.length)

  return (
    <div data-testid="child-agent-timeline" className="flex min-h-0 flex-1 flex-col bg-surface-panel">
      {/* Sticky breadcrumb bar */}
      <nav
        aria-label="Agent hierarchy"
        data-testid="child-agent-breadcrumbs"
        className="sticky top-0 z-10 flex shrink-0 flex-wrap items-center gap-1 border-b border-border-default bg-surface-panel/95 px-3 py-2 text-xs backdrop-blur sm:px-4"
      >
        <button
          type="button"
          data-testid="breadcrumb-main-conversation"
          onClick={() => onSelectChildRun(null)}
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 font-medium text-text-secondary transition-colors hover:bg-surface-interactive hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          <ArrowLeft aria-hidden="true" className="size-3.5" />
          <MessageSquare aria-hidden="true" className="size-3.5 text-text-subtle" />
          <span>Main conversation</span>
        </button>

        {(breadcrumbs.length > 0 ? breadcrumbs : [run]).map((crumb, idx, list) => {
          const isCurrent = idx === list.length - 1
          const label = agentLabel(crumb)
          return (
            <Fragment key={crumb.id}>
              <ChevronRight aria-hidden="true" className="size-3.5 shrink-0 text-text-disabled" />
              {isCurrent ? (
                <span
                  aria-current="page"
                  data-testid="breadcrumb-current-agent"
                  className="inline-flex min-w-0 max-w-[260px] items-center gap-1.5 rounded-md bg-surface-interactive px-2 py-1 font-semibold text-text-primary"
                >
                  <span className="truncate">{label}</span>
                  <span className={cn("shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium", STATUS_BADGE_CLASS[crumb.status])}>
                    {formatChildAgentStatus(crumb.status)}
                  </span>
                </span>
              ) : (
                <button
                  type="button"
                  data-testid="breadcrumb-ancestor-agent"
                  onClick={() => onSelectChildRun(crumb.id)}
                  className="inline-flex min-w-0 max-w-[200px] items-center gap-1 rounded-md px-2 py-1 font-medium text-text-secondary transition-colors hover:bg-surface-interactive hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                >
                  <span className="truncate">{label}</span>
                </button>
              )}
            </Fragment>
          )
        })}
      </nav>

      <ScrollArea className="min-h-0 flex-1">
        <div className={cn("mx-auto flex w-full max-w-3xl flex-col gap-4", compact ? "p-3" : "p-4 sm:p-6")}>
          {/* Sub-agent header card */}
          <section
            aria-label="Sub-agent overview"
            data-testid="child-agent-header"
            className="rounded-xl border border-border-default bg-surface-card p-4 shadow-[var(--shadow-card)]"
          >
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="flex min-w-0 items-start gap-2.5">
                <span className="mt-0.5">
                  <StatusGlyph status={run.status} />
                </span>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-base font-semibold text-text-primary">{primaryName}</h2>
                    {run.role && run.role.trim().toLowerCase() !== primaryName.trim().toLowerCase() && (
                      <span className="rounded-md border border-border-default bg-surface-inset px-1.5 py-0.5 font-mono text-[11px] text-text-subtle">
                        {run.role}
                      </span>
                    )}
                    <span className={cn("rounded-md px-2 py-0.5 text-xs font-medium", STATUS_BADGE_CLASS[run.status])}>
                      {formatChildAgentStatus(run.status)}
                    </span>
                  </div>
                  {run.description && run.description !== primaryName && (
                    <p className="mt-1 text-sm text-text-secondary">{run.description}</p>
                  )}
                </div>
              </div>

              <div className="flex shrink-0 items-center gap-2 text-xs text-text-subtle">
                <span className="tabular-nums">
                  {stepCount} {stepCount === 1 ? "tool step" : "tool steps"}
                </span>
                <span aria-hidden="true">·</span>
                <time dateTime={run.startedAt} suppressHydrationWarning>
                  {formatRelativeTime(run.startedAt)}
                </time>
              </div>
            </div>

            {run.status === "RUNNING" && run.currentActivity && (
              <div
                data-testid="child-agent-live-activity"
                className="mt-3 flex items-center gap-2 rounded-lg border border-status-info/30 bg-status-info-surface px-3 py-2 text-xs font-medium text-status-info"
              >
                <Loader2 aria-hidden="true" className="size-3.5 shrink-0 motion-safe:animate-spin" />
                <span className="min-w-0 truncate">{run.currentActivity}</span>
              </div>
            )}
          </section>

          {/* Nested child sub-agents spawned by this sub-agent */}
          {directChildren.length > 0 && (
            <section aria-label="Delegated sub-agents" data-testid="child-agent-nested-list" className="flex flex-col gap-2">
              <h3 className="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-text-subtle uppercase">
                <Network aria-hidden="true" className="size-3.5" />
                <span>Delegated sub-agents</span>
                <span className="tabular-nums">({directChildren.length})</span>
              </h3>
              <ul className="flex flex-col gap-1.5">
                {directChildren.map((child) => {
                  const childSteps = Math.max(child.stepCount, child.steps.length)
                  return (
                    <li key={child.id}>
                      <button
                        type="button"
                        data-testid="child-agent-nested-item"
                        data-child-run-id={child.id}
                        onClick={() => onSelectChildRun(child.id)}
                        className="flex w-full items-center gap-2.5 rounded-xl border border-border-default bg-surface-card px-3 py-2.5 text-left transition-colors hover:border-border-strong hover:bg-surface-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                      >
                        <StatusGlyph status={child.status} />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-2">
                            <span className="truncate text-sm font-medium text-text-primary">{agentLabel(child)}</span>
                            <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-medium", STATUS_BADGE_CLASS[child.status])}>
                              {formatChildAgentStatus(child.status)}
                            </span>
                          </span>
                          <span className="mt-0.5 block truncate text-xs text-text-subtle">{agentSubLabel(child)}</span>
                        </span>
                        {childSteps > 0 && (
                          <span className="shrink-0 text-xs tabular-nums text-text-subtle">
                            {childSteps} {childSteps === 1 ? "step" : "steps"}
                          </span>
                        )}
                        <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-text-subtle" />
                      </button>
                    </li>
                  )
                })}
              </ul>
            </section>
          )}

          {/* Tool execution timeline */}
          <section aria-label="Tool steps" data-testid="child-agent-steps" className="flex flex-col gap-2">
            <h3 className="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-text-subtle uppercase">
              <Wrench aria-hidden="true" className="size-3.5" />
              <span>Tool calls</span>
              <span className="tabular-nums">({run.steps.length})</span>
            </h3>
            {run.steps.length > 0 ? (
              <ul className="flex flex-col gap-1.5">
                {run.steps.map((step) => (
                  <TimelineStepRow key={step.id} step={step} defaultOpen={step.status === "error"} />
                ))}
              </ul>
            ) : (
              <p className="rounded-xl border border-border-default bg-surface-inset px-4 py-3 text-xs text-text-subtle">
                {run.status === "RUNNING" ? "Waiting for tool calls…" : "No tool calls recorded for this sub-agent."}
              </p>
            )}
          </section>

          {/* Final sub-agent result summary */}
          {run.resultSummary && (
            <section
              aria-label="Sub-agent result"
              data-testid="child-agent-result"
              className={cn(
                "rounded-xl border p-4 text-sm",
                run.status === "FAILED"
                  ? "border-status-danger/40 bg-status-danger-surface text-status-danger"
                  : "border-border-default bg-surface-card text-text-primary",
              )}
            >
              <p className="mb-2 text-xs font-semibold tracking-wide text-text-subtle uppercase">
                {run.status === "FAILED" ? "Failure output" : "Result summary"}
              </p>
              <Markdown>{run.resultSummary}</Markdown>
            </section>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}
