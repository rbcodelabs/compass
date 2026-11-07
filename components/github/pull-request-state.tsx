import { GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft } from "lucide-react"

import type { PullRequestChecks, PullRequestState } from "@/lib/github-pull-request-summary"
import { cn } from "@/lib/utils"

export const PR_STATE_LABEL: Record<PullRequestState, string> = { open: "Open", draft: "Draft", merged: "Merged", closed: "Closed" }

const STATE_TONE: Record<PullRequestState, string> = {
  open: "text-status-success",
  draft: "text-text-subtle",
  merged: "text-primary",
  closed: "text-status-danger",
}

export function PullRequestStateIcon({ state, className }: { state: PullRequestState; className?: string }) {
  const Icon = state === "merged" ? GitMerge : state === "closed" ? GitPullRequestClosed : state === "draft" ? GitPullRequestDraft : GitPullRequest
  return <Icon className={cn(STATE_TONE[state], className)} aria-label={PR_STATE_LABEL[state]} role="img" />
}

export const PR_CHECKS_LABEL: Record<PullRequestChecks, string> = {
  passing: "Checks passing",
  failing: "Checks failing",
  pending: "Checks running",
  none: "No checks",
  unknown: "Checks unavailable",
}

export const PR_CHECKS_DOT: Record<PullRequestChecks, string> = {
  passing: "bg-status-success",
  failing: "bg-status-danger",
  pending: "bg-status-warning",
  none: "bg-border-strong",
  unknown: "bg-border-strong",
}
