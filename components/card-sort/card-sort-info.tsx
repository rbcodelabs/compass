"use client"

/**
 * The ⓘ hint that lets the card-sort screens keep one short line of copy on
 * screen and move the explanation into a hover.
 *
 * Built on the shared Tooltip, so it opens on hover *and* on keyboard focus and
 * closes on Escape — the explanation is never mouse-only. It is read-only text;
 * nothing inside it is interactive, which is what a tooltip may hold.
 */

import type { ReactNode } from "react"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

export function InfoHint({
  label,
  children,
  side = "bottom",
  className,
}: {
  /** Accessible name of the trigger, e.g. "How this round works". */
  label: string
  children: ReactNode
  side?: "top" | "bottom" | "left" | "right"
  className?: string
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        aria-label={label}
        delay={150}
        className={cn(
          "inline-flex size-4 shrink-0 cursor-help items-center justify-center rounded-full border border-border-default align-middle text-[10px] font-semibold leading-none text-text-subtle",
          "hover:border-border-strong hover:text-text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-border-focus",
          className
        )}
      >
        <span aria-hidden>i</span>
      </TooltipTrigger>
      <TooltipContent
        side={side}
        align="start"
        className="max-w-sm flex-col items-start gap-1.5 py-2 text-left leading-5 [&_strong]:font-semibold"
      >
        {children}
      </TooltipContent>
    </Tooltip>
  )
}

/** A one-line statement with its explanation behind a hover ⓘ. */
export function InfoLine({
  children,
  label,
  info,
  className,
}: {
  children: ReactNode
  label: string
  info: ReactNode
  className?: string
}) {
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-1.5 text-xs text-text-secondary", className)}>
      <span>{children}</span>
      <InfoHint label={label}>{info}</InfoHint>
    </span>
  )
}
