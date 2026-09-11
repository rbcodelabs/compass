import Link from "next/link"
import type { ReactNode } from "react"
import { MessageSquareCheck } from "lucide-react"
import type { TrackedSubjectType } from "@/lib/tracked-decisions"

export function RequestDecisionLink({ orgSlug, workspaceSlug, subjectType, subjectId, subjectTitle, label = "Request decision", ariaLabel, className = "inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium hover:bg-muted" }: {
  orgSlug: string
  workspaceSlug: string
  subjectType?: TrackedSubjectType
  subjectId?: string
  subjectTitle?: string
  /** Visible label. May hide itself responsively; pair with `ariaLabel` when it does. */
  label?: ReactNode
  /**
   * Accessible name, for callers whose visible `label` collapses on small
   * viewports. Without this the link would be announced by its icon alone.
   */
  ariaLabel?: string
  className?: string
}) {
  const params = new URLSearchParams()
  if (subjectType) params.set("subjectType", subjectType)
  if (subjectId) params.set("subjectId", subjectId)
  if (subjectTitle) params.set("subjectTitle", subjectTitle)
  const query = params.toString()
  return <Link href={`/${orgSlug}/${workspaceSlug}/decisions/new${query ? `?${query}` : ""}`} className={className} aria-label={ariaLabel}>
    <MessageSquareCheck className="size-4" aria-hidden="true" />{label}
  </Link>
}
