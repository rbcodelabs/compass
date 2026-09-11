import Link from "next/link"
import type { ReactNode } from "react"
import { MessageSquareCheck } from "lucide-react"
import type { TrackedSubjectType } from "@/lib/tracked-decisions"

export type RequestDecisionTarget = {
  orgSlug: string
  workspaceSlug: string
  subjectType?: TrackedSubjectType
  subjectId?: string
  subjectTitle?: string
}

/**
 * The prefilled new-decision URL for a subject. Exported so callers that need
 * their own presentation (e.g. a link styled as a dropdown menu item) share
 * this one definition of the query contract instead of rebuilding it.
 */
export function requestDecisionHref({ orgSlug, workspaceSlug, subjectType, subjectId, subjectTitle }: RequestDecisionTarget): string {
  const params = new URLSearchParams()
  if (subjectType) params.set("subjectType", subjectType)
  if (subjectId) params.set("subjectId", subjectId)
  if (subjectTitle) params.set("subjectTitle", subjectTitle)
  const query = params.toString()
  return `/${orgSlug}/${workspaceSlug}/decisions/new${query ? `?${query}` : ""}`
}

export function RequestDecisionLink({
  label = "Request decision",
  ariaLabel,
  className = "inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium hover:bg-muted",
  ...target
}: RequestDecisionTarget & {
  /** Visible label. May hide itself responsively; pair with `ariaLabel` when it does. */
  label?: ReactNode
  /**
   * Accessible name, for callers whose visible `label` collapses on small
   * viewports. Without this the link would be announced by its icon alone.
   */
  ariaLabel?: string
  className?: string
}) {
  return <Link href={requestDecisionHref(target)} className={className} aria-label={ariaLabel}>
    <MessageSquareCheck className="size-4" aria-hidden="true" />{label}
  </Link>
}
