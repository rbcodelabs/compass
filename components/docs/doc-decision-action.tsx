"use client"

import Link from "next/link"
import { ChevronDown, Clock, CircleAlert } from "lucide-react"
import { RequestDecisionLink } from "@/components/decisions/request-decision-link"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import type { PendingDocDecision } from "@/lib/tracked-decisions"

type Props = { orgSlug: string; workspaceSlug: string; docId: string; docTitle: string; decisions: PendingDocDecision[] | null }
const actionClass = "inline-flex max-w-full items-center gap-2 rounded-md border border-status-warning/30 bg-status-warning-surface px-3 py-2 text-sm font-medium text-status-warning hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"

export function DocDecisionAction({ orgSlug, workspaceSlug, docId, docTitle, decisions }: Props) {
  const base = `/${orgSlug}/${workspaceSlug}`
  if (decisions === null) return <Link href={`${base}/decisions`} className={actionClass}><CircleAlert className="size-4 shrink-0" aria-hidden="true" />Decision status unavailable</Link>
  if (decisions.length === 0) return <RequestDecisionLink orgSlug={orgSlug} workspaceSlug={workspaceSlug} subjectType="DOC" subjectId={docId} subjectTitle={docTitle} />
  const label = decisions.length === 1 ? "Decision pending" : "Decisions pending"
  const accessibleLabel = `${label}, ${decisions.length} ${decisions.length === 1 ? "request" : "requests"}`
  const content = <><Clock className="size-4 shrink-0" aria-hidden="true" /><span>{label}</span><span className="rounded-sm bg-status-warning/10 px-1.5 text-xs tabular-nums" aria-hidden="true">{decisions.length}</span></>
  if (decisions.length === 1) return <Link href={`${base}/reviews/${decisions[0].id}`} className={actionClass} aria-label={accessibleLabel}>{content}</Link>
  return <DropdownMenu>
    <DropdownMenuTrigger className={actionClass} aria-label={accessibleLabel}>{content}<ChevronDown className="size-3 shrink-0" aria-hidden="true" /></DropdownMenuTrigger>
    <DropdownMenuContent align="end" className="w-80 max-w-[calc(100vw-2rem)]">
      {decisions.map(decision => <DropdownMenuItem key={decision.id} render={<Link href={`${base}/reviews/${decision.id}`} />} className="items-start whitespace-normal [overflow-wrap:anywhere] py-2">{decision.title}</DropdownMenuItem>)}
    </DropdownMenuContent>
  </DropdownMenu>
}
