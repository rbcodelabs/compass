"use client"

// What the agent did on a turn, beyond its words: the plan it kept (TodoWrite),
// the subagents it delegated to (Task), and its tool calls. All of it is derived
// client-side by lib/agent-run-stream.ts; this file only draws it.

import { useState } from "react"
import { AlertCircle, Check, ChevronRight, Circle, ListChecks, Loader2, Users } from "lucide-react"
import type { PlanItem, StepStatus, Subagent, ToolStep } from "@/lib/agent-run-stream"

export type TurnActivity = { toolCalls?: ToolStep[]; plan?: PlanItem[]; subagents?: Subagent[] }

export function hasActivity(activity: TurnActivity): boolean {
  return Boolean(activity.toolCalls?.length || activity.plan?.length || activity.subagents?.length)
}

function StatusIcon({ status }: { status: StepStatus }) {
  if (status === "running") return <Loader2 className="size-3 shrink-0 animate-spin text-text-subtle" aria-label="Running" />
  if (status === "error") return <AlertCircle className="size-3 shrink-0 text-status-danger" aria-label="Failed" />
  return <Check className="size-3 shrink-0 text-status-success" aria-label="Done" />
}

function StepRow({ step }: { step: ToolStep }) {
  const [open, setOpen] = useState(false)
  const expandable = Boolean(step.detail || step.result)
  const body = (
    <>
      <StatusIcon status={step.status} />
      <span className="truncate">{step.label}</span>
      {step.detail && <span className="hidden min-w-0 truncate text-text-subtle/70 sm:inline">{step.detail}</span>}
      {expandable && <ChevronRight className={`ml-auto size-3 shrink-0 transition-transform ${open ? "rotate-90" : ""}`} aria-hidden="true" />}
    </>
  )
  return (
    <li className="text-xs text-text-subtle">
      {expandable ? (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center gap-1.5 rounded text-left hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
        >
          {body}
        </button>
      ) : (
        <div className="flex items-center gap-1.5">{body}</div>
      )}
      {open && (
        <div className="mt-1 ml-4 space-y-1 rounded-md bg-surface-inset p-2 font-mono text-[11px] leading-snug break-words whitespace-pre-wrap">
          {step.detail && <p>{step.detail}</p>}
          {step.result && <p className={step.status === "error" ? "text-status-danger" : "text-text-secondary"}>{step.result}</p>}
        </div>
      )}
    </li>
  )
}

export function PlanCard({ plan, running }: { plan: PlanItem[]; running: boolean }) {
  if (plan.length === 0) return null
  const done = plan.filter((item) => item.status === "completed").length
  const pct = Math.round((done / plan.length) * 100)
  return (
    <section aria-label="Plan" className="rounded-lg border border-default bg-surface-inset p-2.5">
      <header className="flex items-center gap-1.5 text-xs font-medium text-text-primary">
        <ListChecks className="size-3.5" aria-hidden="true" />
        Plan
        <span className="ml-auto font-normal text-text-subtle tabular-nums">
          {done}/{plan.length}
        </span>
      </header>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={plan.length}
        aria-valuenow={done}
        aria-label="Plan progress"
        className="mt-1.5 h-1 overflow-hidden rounded-full bg-border-default"
      >
        <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${pct}%` }} />
      </div>
      <ol className="mt-2 flex flex-col gap-1">
        {plan.map((item, i) => {
          const active = item.status === "in_progress"
          return (
            <li key={`${i}-${item.content}`} className={`flex items-start gap-1.5 text-xs ${item.status === "completed" ? "text-text-subtle" : "text-text-primary"}`}>
              <span className="mt-0.5 shrink-0">
                {item.status === "completed" ? (
                  <Check className="size-3 text-status-success" aria-label="Completed" />
                ) : active && running ? (
                  <Loader2 className="size-3 animate-spin" aria-label="In progress" />
                ) : (
                  <Circle className="size-3 text-text-subtle" aria-label={active ? "In progress" : "Pending"} />
                )}
              </span>
              <span className={item.status === "completed" ? "line-through decoration-text-subtle/50" : ""}>
                {active && running ? item.activeForm : item.content}
              </span>
            </li>
          )
        })}
      </ol>
    </section>
  )
}

function SubagentCard({ agent }: { agent: Subagent }) {
  // Open while it works so you can watch; the user's own toggle wins afterwards.
  const [override, setOverride] = useState<boolean | null>(null)
  const open = override ?? agent.status === "running"
  return (
    <li className="rounded-lg border border-default bg-surface-card">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOverride(!open)}
        className="flex w-full items-center gap-1.5 rounded-lg px-2.5 py-2 text-left text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
      >
        <StatusIcon status={agent.status} />
        <span className="min-w-0 truncate font-medium text-text-primary">{agent.description}</span>
        <span className="shrink-0 rounded bg-surface-inset px-1.5 py-0.5 font-mono text-[10px] text-text-subtle">{agent.agentType}</span>
        <span className="ml-auto shrink-0 text-text-subtle tabular-nums">
          {agent.steps.length} {agent.steps.length === 1 ? "call" : "calls"}
        </span>
        <ChevronRight className={`size-3 shrink-0 text-text-subtle transition-transform ${open ? "rotate-90" : ""}`} aria-hidden="true" />
      </button>
      {open && (
        <div className="border-t border-default px-2.5 py-2">
          {agent.steps.length > 0 ? (
            <ul className="flex flex-col gap-1">
              {agent.steps.map((step) => (
                <StepRow key={step.id} step={step} />
              ))}
            </ul>
          ) : (
            <p className="text-xs text-text-subtle">{agent.status === "running" ? "Starting…" : "No tool calls."}</p>
          )}
          {agent.summary && (
            <p className={`mt-2 border-t border-default pt-2 text-xs ${agent.status === "error" ? "text-status-danger" : "text-text-secondary"}`}>
              {agent.summary}
            </p>
          )}
        </div>
      )}
    </li>
  )
}

export function AgentActivity({ toolCalls = [], plan = [], subagents = [], running }: TurnActivity & { running: boolean }) {
  if (!hasActivity({ toolCalls, plan, subagents })) return null
  return (
    <div className="mb-2 flex flex-col gap-2 border-b border-default pb-2">
      <PlanCard plan={plan} running={running} />
      {subagents.length > 0 && (
        <section aria-label="Subagents" className="flex flex-col gap-1.5">
          <h3 className="flex items-center gap-1.5 text-xs font-medium text-text-primary">
            <Users className="size-3.5" aria-hidden="true" />
            Subagents
            <span className="font-normal text-text-subtle">{subagents.length}</span>
          </h3>
          <ul className="flex flex-col gap-1.5">
            {subagents.map((agent) => (
              <SubagentCard key={agent.id} agent={agent} />
            ))}
          </ul>
        </section>
      )}
      {toolCalls.length > 0 && (
        <ul className="flex flex-col gap-1" aria-label="Tool calls">
          {toolCalls.map((step) => (
            <StepRow key={step.id} step={step} />
          ))}
        </ul>
      )}
    </div>
  )
}
