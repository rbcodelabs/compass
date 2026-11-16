"use client"

import type { MouseEvent, ReactNode } from "react"
import { PreviewCard } from "@base-ui/react/preview-card"
import { ArrowUpRight } from "lucide-react"

import { PILL } from "@/components/patterns/entity-pill"
import { useOptionalPanelContext } from "@/components/panels/panel-context"
import { useWorkItemLinkScope } from "@/components/work-item-link-scope"
import { usePullRequest } from "@/components/github/use-pull-request"
import { PR_CHECKS_DOT, PR_CHECKS_LABEL, PR_STATE_LABEL, PullRequestStateIcon } from "@/components/github/pull-request-state"
import type { PullRequestSummary } from "@/lib/github-pull-request-summary"
import {
  formatPullRequestLabel,
  isBarePullRequestLabel,
  pullRequestPanelId,
  type PullRequestRef,
} from "@/lib/github-pull-request-links"
import { cn } from "@/lib/utils"

function nodeText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node)
  if (Array.isArray(node)) return node.map(nodeText).join("")
  if (node && typeof node === "object" && "props" in node) {
    const props = (node as { props?: { children?: ReactNode } }).props
    return nodeText(props?.children)
  }
  return ""
}

const STATE_BADGE_TONE: Record<PullRequestSummary["state"], string> = {
  open: "text-status-success",
  draft: "text-text-subtle",
  merged: "text-primary",
  closed: "text-status-danger",
}

const STATE_DOT_TONE: Record<PullRequestSummary["state"], string> = {
  open: "bg-status-success",
  draft: "bg-border-strong",
  merged: "bg-primary",
  closed: "bg-status-danger",
}

function PullRequestHoverCard({
  summary,
  href,
  onClick,
}: {
  summary: PullRequestSummary
  href: string
  onClick?: (event: MouseEvent<HTMLAnchorElement>) => void
}) {
  const facts: Array<{ label: string; value: string }> = []
  if (summary.headRef && summary.baseRef) facts.push({ label: "Branches", value: `${summary.headRef} → ${summary.baseRef}` })
  if (summary.author) facts.push({ label: "Author", value: summary.author })
  facts.push({ label: "Checks", value: PR_CHECKS_LABEL[summary.checks] })
  facts.push({
    label: "Changes",
    value: `+${summary.additions} -${summary.deletions} (${summary.changedFiles} ${summary.changedFiles === 1 ? "file" : "files"})`,
  })

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2 text-xs text-text-subtle">
        <span className="flex min-w-0 items-center gap-1.5">
          <PullRequestStateIcon state={summary.state} className="size-3.5 shrink-0" />
          <span className="truncate">
            {summary.owner}/{summary.repo} #{summary.number}
          </span>
        </span>
        <span className={cn("inline-flex shrink-0 items-center gap-1.5 rounded-full bg-status-neutral-surface px-2 py-0.5 font-medium", STATE_BADGE_TONE[summary.state])}>
          <span className={cn("size-1.5 rounded-full", STATE_DOT_TONE[summary.state])} aria-hidden="true" />
          {PR_STATE_LABEL[summary.state]}
        </span>
      </div>
      <p className="font-heading text-lg leading-tight tracking-tight">{formatPullRequestLabel(summary)}</p>
      <dl className="mt-1 border-t border-border-default pt-2 text-xs">
        {facts.map((fact) => (
          <div key={fact.label} className="flex justify-between gap-4 py-0.5">
            <dt className="shrink-0 text-text-subtle">{fact.label}</dt>
            <dd className="min-w-0 truncate text-right">{fact.value}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-1 flex items-center justify-between gap-3 text-xs">
        <a href={href} onClick={onClick} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-medium text-primary hover:underline">
          Open details <ArrowUpRight className="size-3" aria-hidden="true" />
        </a>
        <a href={summary.url || href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-text-subtle hover:text-text-primary hover:underline">
          GitHub <ArrowUpRight className="size-3" aria-hidden="true" />
        </a>
      </div>
    </div>
  )
}

/**
 * Shared presentational pill + hover preview card for a resolved GitHub PR.
 * Used by both rendered Markdown (`PullRequestChip`) and TipTap editors (`PullRequestDocChip`), where `children` wraps `<MarkViewContent />`.
 */
export function PullRequestPill({
  summary,
  href,
  onClick,
  children,
  className,
  dataAttrs,
  nonEditableChrome = false,
}: {
  summary: PullRequestSummary
  href: string
  onClick?: (event: MouseEvent<HTMLAnchorElement>) => void
  children: ReactNode
  className?: string
  dataAttrs?: Record<string, string | undefined>
  /** Set true inside TipTap contentEditable so ProseMirror treats the icon and status dot as non-editable chrome. */
  nonEditableChrome?: boolean
}) {
  return (
    <PreviewCard.Root>
      <PreviewCard.Trigger
        href={href}
        onClick={onClick}
        target="_blank"
        rel="noopener noreferrer"
        delay={120}
        closeDelay={150}
        className={cn(PILL, "text-text-primary!", className)}
        data-entity-card="pullRequest"
        {...dataAttrs}
      >
        <PullRequestStateIcon state={summary.state} className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate">{children}</span>
        <span
          className={cn("size-1.5 shrink-0 rounded-full", PR_CHECKS_DOT[summary.checks])}
          role="img"
          aria-label={PR_CHECKS_LABEL[summary.checks]}
          contentEditable={nonEditableChrome ? false : undefined}
        />
      </PreviewCard.Trigger>
      <PreviewCard.Portal>
        <PreviewCard.Positioner side="bottom" align="start" sideOffset={8} className="isolate z-[80]">
          <PreviewCard.Popup className="w-[21rem] max-w-[calc(100vw-2rem)] origin-(--transform-origin) rounded-2xl border border-border-default bg-surface-card p-4 text-left text-text-primary shadow-lg outline-none duration-100 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0">
            <PullRequestHoverCard summary={summary} href={href} onClick={onClick} />
          </PreviewCard.Popup>
        </PreviewCard.Positioner>
      </PreviewCard.Portal>
    </PreviewCard.Root>
  )
}

/**
 * Inline chip for a GitHub PR link in rendered Markdown (descriptions, comments, agent transcript).
 * Bare PR URLs rewrite to `#<number> <Title>` once resolved, while custom `[label](url)` text stays intact.
 * Click opens the PR sidebar in place; a modified click goes to GitHub. When the PR cannot be read (repo not approved, App not
 * configured, 404, or outside workspace scope such as public Portal Docs) the link stays a plain anchor.
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

  const label = isBarePullRequestLabel(nodeText(children), pr, href) ? formatPullRequestLabel(summary) : children

  return (
    <PullRequestPill summary={summary} href={href} onClick={onClick}>
      {label}
    </PullRequestPill>
  )
}
