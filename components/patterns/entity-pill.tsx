"use client"

/**
 * The inline pill for a Compass record, with a hover card. Shared by agent chat (AgentLink) and docs (CompassChip) so a record looks
 * and behaves the same wherever it is mentioned.
 *
 * Presentational only: callers resolve the record (each from its own live source) into EntityPillData and pass it in. While data
 * is null the pill shows its children with no hover card. The pill is a real link; the caller decides what a click does via onClick.
 */
import type { MouseEvent, ReactNode } from "react"
import Link from "next/link"
import { PreviewCard } from "@base-ui/react/preview-card"
import { ArrowUpRight, FileText, MessageSquare } from "lucide-react"

import { isDocEmbedKind } from "@/lib/doc-embeds"
import { humanizeStatus } from "@/lib/spec-docs/labels"
import { statusVisual, type StatusTone } from "@/lib/spec-docs/embed-visual"
import { KIND_ICON, TONE_CLASS } from "@/components/docs/embed-card-icons"
import { cn } from "@/lib/utils"

export type EntityPillData = {
  /** An embed kind (solution, keyResult...) or a chat link type such as feedback. */
  kind: string
  typeLabel: string
  title: string
  status: string | null
  description?: string | null
  facts: ReadonlyArray<{ label: string; value: string }>
  href: string
}

type PillStatus = { label: string; tone: StatusTone }

const DOT_CLASS: Record<StatusTone, string> = {
  neutral: "bg-border-strong",
  progress: "bg-primary",
  done: "bg-status-success",
  warn: "bg-status-warning",
  danger: "bg-status-danger",
}

function KindIcon({ kind, className }: { kind: string; className?: string }) {
  if (isDocEmbedKind(kind)) {
    const Known = KIND_ICON[kind]
    return <Known className={className} aria-hidden="true" />
  }
  if (kind === "feedback") return <MessageSquare className={className} aria-hidden="true" />
  return <FileText className={className} aria-hidden="true" />
}

function statusFor(kind: string, status: string | null): PillStatus | null {
  if (!status) return null
  const visual = isDocEmbedKind(kind) ? statusVisual(kind, status) : null
  return visual ? { label: visual.label, tone: visual.tone } : { label: humanizeStatus(status), tone: "neutral" }
}

export const PILL =
  "inline-flex h-6 max-w-[16rem] items-center gap-1.5 rounded-full border border-border-default bg-surface-card pl-1.5 pr-2.5 align-baseline text-[13px] font-medium leading-none text-text-primary no-underline! transition-colors hover:border-primary/40 hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[popup-open]:border-primary/40 data-[popup-open]:bg-primary/5"

export function EntityPill({
  data,
  href,
  onClick,
  children,
  className,
  dataAttrs,
  clientNav = false,
}: {
  data: EntityPillData | null
  /** The link target; defaults to data.href. */
  href?: string
  onClick?: (event: MouseEvent<HTMLAnchorElement>) => void
  /** The pill text. Defaults to data.title; docs pass the editable link text here. */
  children?: ReactNode
  className?: string
  /** Extra data-* attributes for the anchor (test hooks and styling). */
  dataAttrs?: Record<string, string | undefined>
  /** Navigate with the Next client router (keeps app state) instead of a full page load. Off in the docs editor. */
  clientNav?: boolean
}) {
  const status = data ? statusFor(data.kind, data.status) : null
  const label = children ?? data?.title

  const body = (
    <>
      <KindIcon kind={data ? data.kind : "doc"} className="size-3.5 shrink-0 text-text-subtle" />
      <span className="min-w-0 truncate">{label}</span>
      {status && (
        <span className={cn("size-1.5 shrink-0 rounded-full", DOT_CLASS[status.tone])} role="img" aria-label={status.label} contentEditable={false} />
      )}
    </>
  )

  if (!data) {
    return (
      <a href={href} onClick={onClick} className={cn(PILL, className)} {...dataAttrs}>
        {body}
      </a>
    )
  }

  const target = href ?? data.href
  return (
    <PreviewCard.Root>
      <PreviewCard.Trigger render={clientNav ? <Link href={target} /> : undefined} href={target} onClick={onClick} delay={120} closeDelay={150} className={cn(PILL, className)} {...dataAttrs}>
        {body}
      </PreviewCard.Trigger>
      <PreviewCard.Portal>
        <PreviewCard.Positioner side="bottom" align="start" sideOffset={8} className="isolate z-[80]">
          <PreviewCard.Popup className="w-[21rem] max-w-[calc(100vw-2rem)] origin-(--transform-origin) rounded-2xl border border-border-default bg-surface-card p-4 text-left text-text-primary shadow-lg outline-none duration-100 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0">
            <HoverCardBody data={data} status={status} href={target} onClick={onClick} />
          </PreviewCard.Popup>
        </PreviewCard.Positioner>
      </PreviewCard.Portal>
    </PreviewCard.Root>
  )
}

function HoverCardBody({
  data,
  status,
  href,
  onClick,
}: {
  data: EntityPillData
  status: PillStatus | null
  href: string
  onClick?: (event: MouseEvent<HTMLAnchorElement>) => void
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2 text-xs text-text-subtle">
        <span className="flex min-w-0 items-center gap-1.5">
          <KindIcon kind={data.kind} className="size-3.5 shrink-0" />
          <span className="truncate">{data.typeLabel}</span>
        </span>
        {status && (
          <span className={cn("inline-flex shrink-0 items-center gap-1.5 rounded-full bg-status-neutral-surface px-2 py-0.5 font-medium", TONE_CLASS[status.tone])}>
            <span className={cn("size-1.5 rounded-full", DOT_CLASS[status.tone])} aria-hidden="true" />
            {status.label}
          </span>
        )}
      </div>
      <p className="font-heading text-lg leading-tight tracking-tight">{data.title}</p>
      {data.description && <p className="line-clamp-3 text-[13px] leading-5 text-text-secondary">{data.description}</p>}
      {data.facts.length > 0 && (
        <dl className="mt-1 border-t border-border-default pt-2 text-xs">
          {data.facts.slice(0, 4).map((fact) => (
            <div key={fact.label} className="flex justify-between gap-4 py-0.5">
              <dt className="shrink-0 text-text-subtle">{fact.label}</dt>
              <dd className="min-w-0 truncate text-right">{fact.value}</dd>
            </div>
          ))}
        </dl>
      )}
      <a href={href} onClick={onClick} className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">
        Open <ArrowUpRight className="size-3" aria-hidden="true" />
      </a>
    </div>
  )
}
