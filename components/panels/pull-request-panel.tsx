"use client"

import { ExternalLink, GitBranch } from "lucide-react"

import { Section, Field, PanelSkeleton, PanelError, PanelContainer } from "./panel-parts"
import { usePullRequest } from "@/components/github/use-pull-request"
import { PR_CHECKS_DOT, PR_CHECKS_LABEL, PR_STATE_LABEL, PullRequestStateIcon } from "@/components/github/pull-request-state"
import { MarkdownContent } from "@/components/markdown-content"
import { buttonVariants } from "@/components/ui/button"
import { parsePullRequestPanelId } from "@/lib/github-pull-request-links"
import { cn } from "@/lib/utils"

/**
 * Sidebar for a GitHub pull request, opened from the PR chip in the agent transcript (?detail=pullRequest:owner/repo/123).
 * Read-only: it shows state, checks and the description, and links out to GitHub for anything else.
 */
export function PullRequestPanel({ id, orgSlug, workspaceSlug }: { id: string; orgSlug: string; workspaceSlug: string }) {
  const ref = parsePullRequestPanelId(id)
  const { summary, settled } = usePullRequest(orgSlug, workspaceSlug, ref)

  if (!ref || (settled && !summary)) return <PanelError label="pull request" />
  if (!summary) return <PanelSkeleton />

  return (
    <PanelContainer>
      <div className="flex flex-col gap-2">
        <p className="text-xs text-muted-foreground">
          {summary.owner}/{summary.repo} #{summary.number}
        </p>
        <h3 className="text-lg font-semibold leading-snug">{summary.title}</h3>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span className="inline-flex items-center gap-1.5">
            <PullRequestStateIcon state={summary.state} className="size-4" />
            {PR_STATE_LABEL[summary.state]}
          </span>
          <span className="inline-flex items-center gap-1.5 text-muted-foreground">
            <span className={cn("size-2 rounded-full", PR_CHECKS_DOT[summary.checks])} aria-hidden="true" />
            {PR_CHECKS_LABEL[summary.checks]}
          </span>
        </div>
        <a href={summary.url} target="_blank" rel="noopener noreferrer" className={cn(buttonVariants({ variant: "outline", size: "sm" }), "w-fit")}>
          <ExternalLink aria-hidden /> Open on GitHub
        </a>
      </div>

      <div className="flex flex-col gap-3">
        {summary.author && <Field label="Author">{summary.author}</Field>}
        <Field label="Branches">
          <span className="inline-flex flex-wrap items-center gap-1.5 font-mono text-xs">
            <GitBranch className="size-3.5" aria-hidden="true" />
            {summary.headRef} <span aria-hidden="true">→</span> {summary.baseRef}
          </span>
        </Field>
        <Field label="Changes">
          <span className="text-sm">
            {summary.changedFiles} {summary.changedFiles === 1 ? "file" : "files"},{" "}
            <span className="text-status-success">+{summary.additions}</span> <span className="text-status-danger">-{summary.deletions}</span> across {summary.commits}{" "}
            {summary.commits === 1 ? "commit" : "commits"}
          </span>
        </Field>
        <Field label="Conversation">{summary.comments + summary.reviewComments} comments</Field>
        {summary.state === "open" && summary.mergeable === false && <Field label="Merge status">Has conflicts with {summary.baseRef}</Field>}
      </div>

      {summary.failingChecks.length > 0 && (
        <Section label="Failing checks" count={summary.failingChecks.length}>
          <ul className="flex flex-col gap-1 text-sm">
            {summary.failingChecks.map((name) => (
              <li key={name} className="flex items-center gap-2">
                <span className="size-1.5 shrink-0 rounded-full bg-status-danger" aria-hidden="true" />
                {name}
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section label="Description">
        {summary.body?.trim() ? <MarkdownContent>{summary.body}</MarkdownContent> : <p className="text-sm text-muted-foreground">No description.</p>}
      </Section>
    </PanelContainer>
  )
}
