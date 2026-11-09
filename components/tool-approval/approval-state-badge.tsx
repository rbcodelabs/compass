import { AlertTriangle, Ban, CheckCircle2, CircleDashed, Clock, Loader2, ShieldQuestion, XCircle } from "lucide-react"
import { StatusBadge } from "@/components/patterns/status-badge"
import type { ApprovalStateKey, ApprovalTone } from "@/lib/tool-approval/state"
import { APPROVAL_STATES } from "@/lib/tool-approval/state"

const ICON: Record<ApprovalStateKey, typeof Clock> = {
  PENDING: Clock, APPLYING: Loader2, APPLIED: CheckCircle2, DENIED: XCircle, EXPIRED: CircleDashed, STALE: AlertTriangle,
  FAILED: XCircle, UNKNOWN_OUTCOME: ShieldQuestion, BLOCKED: Ban, NOT_RUN: AlertTriangle, SUPERSEDED: CircleDashed,
}

export function ApprovalStateBadge({ state }: { state: ApprovalStateKey }) {
  const { label, tone } = APPROVAL_STATES[state]
  const Icon = ICON[state]
  return (
    <StatusBadge status={tone as ApprovalTone} data-testid="approval-state" data-state={state} icon={<Icon className={state === "APPLYING" ? "animate-spin" : undefined} aria-hidden="true" />}>
      {label}
    </StatusBadge>
  )
}
