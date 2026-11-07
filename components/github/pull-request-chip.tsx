"use client"

import type { MouseEvent, ReactNode } from "react"

import { PILL } from "@/components/patterns/entity-pill"
import { useOptionalPanelContext } from "@/components/panels/panel-context"
import { useWorkItemLinkScope } from "@/components/work-item-link-scope"
import { usePullRequest } from "@/components/github/use-pull-request"
import { PR_CHECKS_DOT, PR_CHECKS_LABEL, PullRequestStateIcon } from "@/components/github/pull-request-state"
import { pullRequestPanelId, type PullRequestRef } from "@/lib/github-pull-request-links"
import { cn } from "@/lib/utils"

/**
 * Inline chip for a GitHub PR link in the agent transcript. Click opens the PR sidebar in place; a modified click still goes to
 * GitHub. When the PR cannot be read (repo not approved, App not configured, no access) the link stays a plain anchor.
 */
export function PullRequestChip({ href, pr, children }: { href: string; pr: PullRequestRef; children?: ReactNode }) {
  const panels = useOptionalPanelContext()
  const scope = useWorkItemLinkScope()
  const orgSlug = scope?.orgSlug ?? ""
  const workspaceSlug = scope?.workspaceSlug ?? ""
  const { summary, settled } = usePullRequest(orgSlug, workspaceSlug, scope ? pr : null)

  const plain = (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  )
  if (!scope || (settled && !summary)) return plain
  if (!summary) return <a href={href} className={cn(PILL, "w-28 animate-pulse bg-surface-interactive")} aria-busy="true" aria-label="Loading" />

  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    if (panels) {
      event.preventDefault()
      panels.openPanel("pullRequest", pullRequestPanelId(pr))
    }
  }

  return (
    <a href={href} onClick={onClick} target="_blank" rel="noopener noreferrer" className={PILL} data-entity-card="pullRequest">
      <PullRequestStateIcon state={summary.state} className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">
        #{summary.number} {summary.title}
      </span>
      <span className={cn("size-1.5 shrink-0 rounded-full", PR_CHECKS_DOT[summary.checks])} role="img" aria-label={PR_CHECKS_LABEL[summary.checks]} />
    </a>
  )
}
