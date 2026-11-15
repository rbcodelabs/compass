import type { ReactNode } from "react"
import { CheckCircle2, CircleDot, RotateCcw, XCircle } from "lucide-react"
import { DecisionAnswerList } from "@/components/decisions/decision-answers"
import { DecisionLongForm } from "@/components/decisions/decision-long-form"
import type { TrackedDecisionAnswer } from "@/lib/tracked-decision-types"
import { cn } from "@/lib/utils"

function outcomeTone(outcomeClass: string): {
  surfaceClass: string
  iconClass: string
  Icon: typeof CheckCircle2
} {
  switch (outcomeClass) {
    case "APPROVE":
      return {
        surfaceClass: "border-status-success/30 bg-status-success-surface text-status-success",
        iconClass: "text-status-success",
        Icon: CheckCircle2,
      }
    case "REQUEST_CHANGES":
      return {
        surfaceClass: "border-status-warning/30 bg-status-warning-surface text-status-warning",
        iconClass: "text-status-warning",
        Icon: RotateCcw,
      }
    case "REJECT":
      return {
        surfaceClass: "border-status-danger/30 bg-status-danger-surface text-status-danger",
        iconClass: "text-status-danger",
        Icon: XCircle,
      }
    default:
      return {
        surfaceClass: "border-border-default bg-surface-inset text-text-primary",
        iconClass: "text-text-secondary",
        Icon: CircleDot,
      }
  }
}

export function DecisionOutcomeBanner({
  label,
  description,
  outcomeClass,
  decidedBy,
  formattedTimestamp,
  timestampPreposition = "at",
  rationale,
  answers = [],
  actions,
  compact = false,
}: {
  label: string
  description?: string | null
  outcomeClass: string
  decidedBy: string
  formattedTimestamp: string
  timestampPreposition?: "at" | "on"
  rationale?: string | null
  answers?: TrackedDecisionAnswer[]
  actions?: ReactNode
  compact?: boolean
}) {
  const { surfaceClass, iconClass, Icon } = outcomeTone(outcomeClass)

  return (
    <section
      data-testid="decision-outcome-banner"
      data-outcome={outcomeClass}
      className={cn(
        "min-w-0 space-y-2.5 rounded-lg border text-sm",
        compact ? "p-3" : "p-4",
        surfaceClass,
      )}
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <Icon className={cn("mt-0.5 size-4 shrink-0", iconClass)} aria-hidden="true" />
        <p className="min-w-0 flex-1 break-words [overflow-wrap:anywhere]">
          Decision recorded: <strong>{label}</strong> by {decidedBy} {timestampPreposition} {formattedTimestamp}.
        </p>
      </div>
      {description && (
        <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-foreground/85">
          {description}
        </p>
      )}
      <DecisionAnswerList answers={answers} />
      {rationale && <DecisionLongForm className="text-foreground" content={rationale} />}
      {actions && (
        <div className="flex flex-wrap items-center gap-4 border-t border-current/15 pt-2.5 text-sm">
          {actions}
        </div>
      )}
    </section>
  )
}
