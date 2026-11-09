import type { ReactNode } from "react"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { ApprovalStateBadge } from "@/components/tool-approval/approval-state-badge"
import { EffectDiff } from "@/components/tool-approval/effect-diff"
import { APPROVAL_STATES } from "@/lib/tool-approval/state"
import type { ApprovalView } from "@/lib/tool-approval/view"
import { cn } from "@/lib/utils"

const REQUESTER: Record<ApprovalView["requestedBy"], string> = { agent: "An AI agent", person: "A person", service: "An API key" }

/** Fixed UTC format: the same text on the server render and in tests, with no locale or time-zone surprises. */
export function formatWhen(iso: string | null): string {
  if (!iso) return "-"
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? "-" : `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium text-text-subtle">{label}</dt>
      <dd className="m-0 mt-0.5 min-w-0 text-sm break-words text-text-primary [overflow-wrap:anywhere]">{children}</dd>
    </div>
  )
}

const tone = {
  success: "border-status-success/40 bg-status-success-surface text-status-success",
  info: "border-status-info/40 bg-status-info-surface text-status-info",
  warning: "border-status-warning/40 bg-status-warning-surface text-status-warning",
  danger: "border-status-danger/40 bg-status-danger-surface text-status-danger",
  neutral: "border-border-default bg-surface-inset text-text-secondary",
} as const

/** What happened to this approval, in one box: the status, who decided and when, and the executor's receipt. No buttons. */
export function OutcomeBox({ view }: { view: ApprovalView }) {
  const { state, decision, receipt } = view
  return (
    <section aria-label="Outcome" data-testid="approval-outcome" className={cn("min-w-0 space-y-2 rounded-lg border p-4 text-sm", tone[APPROVAL_STATES[state.key].tone])}>
      <p className="m-0 font-semibold">{state.label}</p>
      <p className="m-0 text-text-primary">{state.explanation}</p>
      {decision && (
        <p className="m-0 break-words text-text-primary [overflow-wrap:anywhere]">
          {decision.approved ? "Approved" : "Denied"} by {decision.decidedByName ?? "a workspace admin"} at {formatWhen(decision.decidedAt)}.
        </p>
      )}
      {receipt && (
        <p className="m-0 break-words text-text-primary [overflow-wrap:anywhere]" data-testid="approval-receipt">
          Receipt: {receipt.status.toLowerCase()}{receipt.appliedAt ? ` at ${formatWhen(receipt.appliedAt)}` : ""}{receipt.error ? `. ${receipt.error}` : ""}
        </p>
      )}
    </section>
  )
}

/** The full read-only view of one approval: summary, facts, the before -> after effect, and the arguments. */
export function ApprovalDetail({ view }: { view: ApprovalView }) {
  return (
    <div className="min-w-0 space-y-6">
      <header className="min-w-0 space-y-2">
        <p className="m-0 text-sm text-text-subtle">Tool approval{view.displayId ? ` · ${view.displayId}` : ""}</p>
        <h1 className="m-0 text-2xl font-semibold break-words [overflow-wrap:anywhere]">{view.title}</h1>
        {view.summary && <p className="m-0 text-sm break-words text-text-secondary [overflow-wrap:anywhere]">{view.summary}</p>}
        <ApprovalStateBadge state={view.state.key} />
      </header>

      <section aria-label="Request" className="min-w-0 rounded-lg border border-border-default bg-surface-panel p-4">
        <dl className="m-0 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Fact label="Tool"><code className="font-mono text-xs">{view.tool}</code></Fact>
          <Fact label="Capability"><code className="font-mono text-xs">{view.capabilityClass}</code></Fact>
          <Fact label="Requested by">{REQUESTER[view.requestedBy]}</Fact>
          <Fact label="Requested">{formatWhen(view.createdAt)}</Fact>
          <Fact label="Expires">{formatWhen(view.expiresAt)}</Fact>
        </dl>
      </section>

      <section aria-label="What will change" className="min-w-0 space-y-3">
        <h2 className="m-0 text-lg font-semibold">What will change</h2>
        <p className="m-0 text-sm text-text-secondary">Taken from the stored request, not from anything the agent said. This is the exact change that runs if you approve, and only if nothing has moved by then.</p>
        <EffectDiff before={view.before} after={view.after} />
      </section>

      <section aria-label="Arguments" className="min-w-0">
        <Collapsible className="min-w-0 rounded-lg border border-border-default bg-surface-panel">
          <CollapsibleTrigger className="flex min-h-11 w-full cursor-pointer items-center px-4 py-3 text-left text-sm font-medium sm:min-h-9">
            Call arguments (as stored, with sensitive fields removed)
          </CollapsibleTrigger>
          <CollapsibleContent>
            <pre data-testid="approval-args" className="m-0 max-h-96 min-w-0 overflow-auto px-4 pb-4 font-mono text-xs break-words whitespace-pre-wrap [overflow-wrap:anywhere]">{JSON.stringify(view.args, null, 2)}</pre>
          </CollapsibleContent>
        </Collapsible>
      </section>
    </div>
  )
}
