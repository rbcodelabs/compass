"use client"

import Link from "next/link"
import { ArrowRight, ChevronDown, CircleAlert, CircleCheck, CircleSlash, Clock, PencilLine } from "lucide-react"
import { RequestDecisionLink, requestDecisionHref } from "@/components/decisions/request-decision-link"
import { StatusBadge } from "@/components/patterns/status-badge"
import { buttonVariants } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuLabel, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import type { DecidedDocDecision, DocDecisions } from "@/lib/tracked-decisions"

type Props = { orgSlug: string; workspaceSlug: string; docId: string; docTitle: string; decisions: DocDecisions | null }
const actionClass = "inline-flex max-w-full items-center gap-2 rounded-md border border-status-warning/30 bg-status-warning-surface px-3 py-2 text-sm font-medium text-status-warning hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"

/**
 * Same tones the Decisions list uses, so an outcome reads identically
 * everywhere. The label text collapses below `sm` — this badge sits in the
 * doc toolbar, which is a horizontally-scrollable strip on mobile; a
 * full-text badge here would eat most of the available scroll width and
 * crowd out the formatting buttons. The icon alone still conveys the
 * outcome, and the trigger's `aria-label` (see `decidedSummary`) keeps it
 * accessible regardless of what's visually shown.
 */
function outcomeBadge(decided: DecidedDocDecision) {
  const collapsed = (text: string) => <span className="hidden sm:inline">{text}</span>
  switch (decided.outcome) {
    case "APPROVE": return <StatusBadge status="success" icon={<CircleCheck />}>{collapsed("Approved")}</StatusBadge>
    case "REQUEST_CHANGES": return <StatusBadge status="warning" icon={<PencilLine />}>{collapsed("Changes requested")}</StatusBadge>
    case "REJECT": return <StatusBadge status="danger" icon={<CircleSlash />}>{collapsed("Rejected")}</StatusBadge>
    // An outcome class added later should still render, labelled by the option.
    // (icon included so the collapsed mobile badge isn't left empty)
    default: return <StatusBadge status="neutral" icon={<CircleAlert />}>{collapsed(decided.outcomeLabel)}</StatusBadge>
  }
}

function decidedSummary(decided: DecidedDocDecision) {
  const outcome = decided.outcome === "APPROVE" ? "Approved" : decided.outcome === "REQUEST_CHANGES" ? "Changes requested" : decided.outcome === "REJECT" ? "Rejected" : decided.outcomeLabel
  const when = decided.decidedAt.toLocaleDateString(undefined, { month: "short", day: "numeric" })
  return decided.reviewerName ? `${outcome} by ${decided.reviewerName} · ${when}` : `${outcome} · ${when}`
}

export function DocDecisionAction({ orgSlug, workspaceSlug, docId, docTitle, decisions }: Props) {
  const base = `/${orgSlug}/${workspaceSlug}`
  if (decisions === null) return <Link href={`${base}/decisions`} className={actionClass} aria-label="Decision status unavailable"><CircleAlert className="size-4 shrink-0" aria-hidden="true" /><span className="hidden sm:inline">Decision status unavailable</span></Link>

  const { pending, latestDecided } = decisions

  // An open question outranks a settled one: pending is actionable.
  if (pending.length > 0) {
    const label = pending.length === 1 ? "Decision pending" : "Decisions pending"
    const accessibleLabel = `${label}, ${pending.length} ${pending.length === 1 ? "request" : "requests"}`
    // The count is only rendered for 2+. At one request it duplicated the
    // singular label and advertised a list that does not open at that count.
    // The label text collapses below `sm` for the same reason the outcome
    // badge does (see outcomeBadge) — this trigger lives in the horizontally-
    // scrollable doc toolbar on mobile. The count badge stays visible on its
    // own since "clock + N" is still legible without the words, and the
    // multi-request case always renders one; accessibility is covered by
    // `accessibleLabel` on the trigger itself.
    const content = <><Clock className="size-4 shrink-0" aria-hidden="true" /><span className="hidden sm:inline">{label}</span>{pending.length > 1 && <span className="rounded-sm bg-status-warning/10 px-1.5 text-xs tabular-nums" aria-hidden="true">{pending.length}</span>}</>
    if (pending.length === 1) return <Link href={`${base}/reviews/${pending[0].id}`} className={actionClass} aria-label={accessibleLabel}>{content}</Link>
    return <DropdownMenu>
      <DropdownMenuTrigger className={actionClass} aria-label={accessibleLabel}>{content}<ChevronDown className="size-3 shrink-0" aria-hidden="true" /></DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={8} className="w-80 max-w-[calc(100vw-2rem)] p-2 shadow-lg">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="px-2 pb-2 pt-1">Pending decisions · {pending.length}</DropdownMenuLabel>
          {pending.map(decision => <DropdownMenuItem key={decision.id} aria-label={decision.title} render={<Link href={`${base}/reviews/${decision.id}`} />} className="mb-1 cursor-pointer items-center gap-3 whitespace-normal rounded-lg border border-border-default bg-surface-panel px-3 py-3 last:mb-0 hover:bg-accent data-highlighted:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
            <span className="min-w-0 flex-1 space-y-1">
              <span className="block font-medium leading-5 [overflow-wrap:anywhere]">{decision.title}</span>
              <span className="block text-xs font-medium text-popover-foreground underline underline-offset-4">Open decision</span>
            </span>
            <ArrowRight className="size-4 text-popover-foreground" aria-hidden="true" />
          </DropdownMenuItem>)}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  }

  // Nothing pending, but a decision was recorded: surface the outcome instead
  // of the zero state, which read as though the call had never been made.
  if (latestDecided) {
    return <DropdownMenu>
      <DropdownMenuTrigger className={`${buttonVariants({ variant: "outline" })} gap-2`} aria-label={`${decidedSummary(latestDecided)} — decision actions`}>
        {outcomeBadge(latestDecided)}
        <ChevronDown className="size-3 shrink-0 text-text-subtle" aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={8} className="w-80 max-w-[calc(100vw-2rem)] p-2 shadow-lg">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="px-2 pb-2 pt-1">Latest decision</DropdownMenuLabel>
          <DropdownMenuItem aria-label={latestDecided.title} render={<Link href={`${base}/reviews/${latestDecided.id}`} />} className="mb-1 cursor-pointer items-center gap-3 whitespace-normal rounded-lg border border-border-default bg-surface-panel px-3 py-3 hover:bg-accent data-highlighted:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
            <span className="min-w-0 flex-1 space-y-1">
              <span className="block font-medium leading-5 [overflow-wrap:anywhere]">{latestDecided.title}</span>
              <span className="block text-xs text-text-subtle">{decidedSummary(latestDecided)}</span>
            </span>
            <ArrowRight className="size-4 text-popover-foreground" aria-hidden="true" />
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem aria-label="Request another decision" render={<Link href={requestDecisionHref({ orgSlug, workspaceSlug, subjectType: "DOC", subjectId: docId, subjectTitle: docTitle })} />} className="cursor-pointer gap-2">
            <PencilLine className="size-4" aria-hidden="true" />
            Request another decision
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  }

  return <RequestDecisionLink
    orgSlug={orgSlug}
    workspaceSlug={workspaceSlug}
    subjectType="DOC"
    subjectId={docId}
    subjectTitle={docTitle}
    // Collapses below `sm` — see outcomeBadge's comment for why.
    label={<span className="hidden sm:inline">Request decision</span>}
    ariaLabel="Request decision"
  />
}
