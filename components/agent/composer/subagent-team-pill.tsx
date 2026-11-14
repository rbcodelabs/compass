"use client"

/**
 * Composer footer pill + upward hierarchy tree popover (bottom sheet on narrow viewports)
 * for inspecting a conversation's sub-agent team and drilling into any child sub-agent's timeline.
 */

import { useId, useMemo, useRef, useState, type KeyboardEvent } from "react"
import {
  AlertCircle,
  Check,
  CheckCircle2,
  ChevronDown,
  Circle,
  CornerDownRight,
  Loader2,
  MessageSquare,
  Network,
} from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet"
import { useNarrowViewport } from "@/components/agent/composer/use-narrow-viewport"
import {
  agentLabel,
  agentSubLabel,
  flattenAgentTree,
  summarizeAgentTeam,
  type AgentTreeRow,
  type ChildAgentStatus,
  type SerializedChildAgentRun,
} from "@/lib/agent/child-agent-tree"
import { cn } from "@/lib/utils"

type SubagentTeamPillProps = {
  runs: readonly SerializedChildAgentRun[]
  selectedChildRunId: string | null
  onSelectChildRun: (childRunId: string | null) => void
  open?: boolean
  onOpenChange?: (open: boolean) => void
  className?: string
}

function ChildStatusIcon({ status }: { status: ChildAgentStatus }) {
  switch (status) {
    case "RUNNING":
      return <Loader2 aria-hidden="true" className="size-3.5 shrink-0 text-status-info motion-safe:animate-spin" />
    case "FAILED":
      return <AlertCircle aria-hidden="true" className="size-3.5 shrink-0 text-status-danger" />
    case "SUCCEEDED":
      return <CheckCircle2 aria-hidden="true" className="size-3.5 shrink-0 text-status-success" />
    case "INTERRUPTED":
      return <Circle aria-hidden="true" className="size-3.5 shrink-0 text-text-subtle" />
  }
}

function TeamTreeList({
  rows,
  selectedChildRunId,
  onSelect,
  sheet,
  listRef,
}: {
  rows: readonly AgentTreeRow[]
  selectedChildRunId: string | null
  onSelect: (childRunId: string | null) => void
  sheet: boolean
  listRef: React.RefObject<HTMLDivElement | null>
}) {
  const treeItems = () => Array.from(listRef.current?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? [])

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const items = treeItems()
    if (items.length === 0) return
    const at = items.indexOf(document.activeElement as HTMLElement)
    const focusAt = (idx: number) => items[(idx + items.length) % items.length]?.focus()
    if (e.key === "ArrowDown") {
      e.preventDefault()
      focusAt(at + 1)
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      focusAt(at < 0 ? items.length - 1 : at - 1)
    } else if (e.key === "Home") {
      e.preventDefault()
      focusAt(0)
    } else if (e.key === "End") {
      e.preventDefault()
      focusAt(items.length - 1)
    } else if ((e.key === "Enter" || e.key === " ") && at >= 0) {
      e.preventDefault()
      items[at].click()
    }
  }

  const mainSelected = selectedChildRunId === null

  return (
    <div
      ref={listRef}
      role="tree"
      aria-label="Sub-agent team"
      onKeyDown={onKeyDown}
      className="flex flex-col gap-0.5"
    >
      <div
        role="treeitem"
        aria-level={1}
        aria-selected={mainSelected}
        tabIndex={mainSelected ? 0 : -1}
        data-testid="subagent-tree-main"
        onClick={() => onSelect(null)}
        className={cn(
          "flex cursor-pointer items-center gap-2 rounded-lg px-2.5 text-left outline-none transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          sheet ? "min-h-11 py-2 text-[14px]" : "min-h-8 py-1.5 text-[12.5px]",
          mainSelected && "bg-surface-interactive font-medium text-text-primary",
        )}
      >
        <MessageSquare aria-hidden="true" className="size-3.5 shrink-0 text-text-subtle" />
        <span className="min-w-0 flex-1 truncate">Main conversation</span>
        <Check
          aria-hidden="true"
          className={cn("size-3.5 shrink-0 text-primary", !mainSelected && "invisible")}
        />
      </div>

      <div role="separator" className="my-0.5 border-t border-border-default/70" />

      {rows.map(({ run, level }) => {
        const selected = run.id === selectedChildRunId
        const indentSteps = Math.min(Math.max(0, level - 1), 4)
        const primary = agentLabel(run)
        const secondary = agentSubLabel(run)
        const stepCount = Math.max(run.stepCount, run.steps.length)
        return (
          <div
            key={run.id}
            role="treeitem"
            aria-level={level}
            aria-selected={selected}
            aria-label={`${primary} — ${secondary}`}
            tabIndex={selected ? 0 : -1}
            data-testid="subagent-tree-item"
            data-child-run-id={run.id}
            style={indentSteps > 0 ? { paddingLeft: `${10 + indentSteps * 14}px` } : undefined}
            onClick={() => onSelect(run.id)}
            className={cn(
              "flex cursor-pointer items-start gap-2 rounded-lg px-2.5 text-left outline-none transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              sheet ? "min-h-11 py-2 text-[14px]" : "py-1.5 text-[12.5px]",
              selected && "bg-surface-interactive text-text-primary",
            )}
          >
            {level > 1 && (
              <CornerDownRight
                aria-hidden="true"
                className="mt-0.5 size-3 shrink-0 text-text-disabled"
              />
            )}
            <span className="mt-0.5 shrink-0">
              <ChildStatusIcon status={run.status} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5">
                <span className={cn("min-w-0 flex-1 truncate text-text-primary", selected ? "font-semibold" : "font-medium")}>
                  {primary}
                </span>
                {stepCount > 0 && (
                  <span className="shrink-0 tabular-nums text-[11px] text-text-subtle">
                    {stepCount} {stepCount === 1 ? "step" : "steps"}
                  </span>
                )}
              </span>
              <span className="block truncate text-[11px] text-text-subtle">{secondary}</span>
            </span>
            <Check
              aria-hidden="true"
              className={cn("mt-0.5 size-3.5 shrink-0 text-primary", !selected && "invisible")}
            />
          </div>
        )
      })}
    </div>
  )
}

export function SubagentTeamPill({
  runs,
  selectedChildRunId,
  onSelectChildRun,
  open: controlledOpen,
  onOpenChange,
  className,
}: SubagentTeamPillProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false)
  const open = runs.length > 0 && (controlledOpen ?? uncontrolledOpen)
  const setOpen = (next: boolean) => {
    if (controlledOpen === undefined) setUncontrolledOpen(next)
    onOpenChange?.(next)
  }

  const narrow = useNarrowViewport()
  const listRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popupId = useId()

  const summary = useMemo(() => summarizeAgentTeam(runs), [runs])
  const rows = useMemo(() => flattenAgentTree(runs), [runs])
  const selectedRun = useMemo(
    () => (selectedChildRunId ? runs.find((run) => run.id === selectedChildRunId) ?? null : null),
    [runs, selectedChildRunId],
  )

  if (runs.length === 0) return null

  function handleSelect(nextId: string | null) {
    onSelectChildRun(nextId)
    setOpen(false)
    requestAnimationFrame(() => triggerRef.current?.focus())
  }

  const focusSelected = () =>
    listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]') ??
    listRef.current?.querySelector<HTMLElement>('[role="treeitem"]') ??
    undefined

  const headerMeta =
    summary.active > 0
      ? `${summary.active} working · ${summary.total} total`
      : summary.failed > 0
        ? `${summary.failed} failed · ${summary.total} total`
        : `${summary.total} ${summary.total === 1 ? "sub-agent" : "sub-agents"}`

  const triggerClass = cn(
    "inline-flex h-7 min-w-0 max-w-full items-center gap-1.5 rounded-lg border px-2 text-[12.5px] outline-none transition-colors",
    summary.tone === "active"
      ? "border-status-info/40 bg-status-info-surface text-status-info"
      : summary.tone === "failed"
        ? "border-status-danger/40 bg-status-danger-surface text-status-danger"
        : selectedRun
          ? "border-border-strong bg-surface-interactive text-text-primary"
          : "border-border bg-card text-foreground",
    "hover:border-border-strong focus-visible:ring-2 focus-visible:ring-ring aria-expanded:border-ring aria-expanded:ring-[3px] aria-expanded:ring-ring/20",
    "motion-reduce:transition-none max-sm:h-9 @max-md/composer:w-full",
    className,
  )

  const pillIcon =
    summary.tone === "active" ? (
      <Loader2 aria-hidden="true" className="size-3.5 shrink-0 motion-safe:animate-spin" />
    ) : summary.tone === "failed" ? (
      <AlertCircle aria-hidden="true" className="size-3.5 shrink-0" />
    ) : (
      <Network aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
    )

  const pillText = selectedRun ? `${summary.label} · ${agentLabel(selectedRun)}` : summary.label

  const triggerBody = (
    <>
      {pillIcon}
      <span className="min-w-0 truncate font-medium">{pillText}</span>
      <ChevronDown className="size-3.5 shrink-0 opacity-75 @max-md/composer:ml-auto" aria-hidden="true" />
    </>
  )

  const onTriggerKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault()
      setOpen(true)
    }
  }

  const wrap = "flex min-w-0 flex-[0_1_auto] @max-md/composer:flex-1"

  if (narrow) {
    return (
      <div className={wrap}>
        <button
          ref={triggerRef}
          type="button"
          data-testid="composer-subagent-pill"
          className={triggerClass}
          aria-label={`Sub-agent team: ${pillText}`}
          aria-haspopup="dialog"
          aria-controls={open ? popupId : undefined}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          onKeyDown={onTriggerKeyDown}
        >
          {triggerBody}
        </button>
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetContent
            id={popupId}
            aria-label="Sub-agent team"
            side="bottom"
            showCloseButton={false}
            initialFocus={focusSelected}
            className="max-h-[80dvh] gap-0 overflow-auto rounded-t-2xl p-2 pb-6"
            data-testid="subagent-team-popover"
          >
            <div aria-hidden="true" className="mx-auto mt-0.5 mb-2 h-1 w-9 rounded bg-border-strong" />
            <div className="flex items-center justify-between px-2.5 pt-2 pb-1.5">
              <SheetTitle className="text-[10.5px] font-semibold tracking-[0.07em] text-muted-foreground uppercase">
                Sub-agent team
              </SheetTitle>
              <span className="text-[11px] tabular-nums text-text-subtle">{headerMeta}</span>
            </div>
            <TeamTreeList
              rows={rows}
              selectedChildRunId={selectedChildRunId}
              onSelect={handleSelect}
              sheet
              listRef={listRef}
            />
          </SheetContent>
        </Sheet>
      </div>
    )
  }

  return (
    <div className={wrap}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          ref={triggerRef}
          data-testid="composer-subagent-pill"
          className={triggerClass}
          aria-label={`Sub-agent team: ${pillText}`}
          aria-haspopup="dialog"
          aria-controls={open ? popupId : undefined}
          onKeyDown={onTriggerKeyDown}
        >
          {triggerBody}
        </PopoverTrigger>
        <PopoverContent
          id={popupId}
          aria-label="Sub-agent team"
          side="top"
          align="start"
          sideOffset={8}
          initialFocus={focusSelected}
          data-testid="subagent-team-popover"
          className="max-h-[min(380px,var(--available-height))] w-[min(360px,calc(100vw-1.5rem))] overflow-auto rounded-xl border border-border bg-popover p-1.5 text-popover-foreground shadow-lg"
        >
          <div className="flex items-center justify-between px-2.5 pt-2 pb-1.5">
            <span className="text-[10.5px] font-semibold tracking-[0.07em] text-muted-foreground uppercase">
              Sub-agent team
            </span>
            <span className="text-[11px] tabular-nums text-text-subtle">{headerMeta}</span>
          </div>
          <TeamTreeList
            rows={rows}
            selectedChildRunId={selectedChildRunId}
            onSelect={handleSelect}
            sheet={false}
            listRef={listRef}
          />
        </PopoverContent>
      </Popover>
    </div>
  )
}
