"use client"

/**
 * The quick-filter box shared by the kanban and table views of a card sort.
 * Matching lives in lib/card-sort-filter.ts; this is only the input, a clear
 * button, and a polite "N of M" readout so a screen reader hears the result of
 * each keystroke without focus leaving the box.
 */

import { useRef } from "react"
import { Search, X } from "lucide-react"

import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

type Props = {
  value: string
  onChange: (value: string) => void
  /** Objects matching the filter. */
  shown: number
  /** All objects in the round. */
  total: number
  className?: string
}

export function CardSortQuickFilter({ value, onChange, shown, total, className }: Props) {
  const active = value.trim().length > 0
  const inputRef = useRef<HTMLInputElement>(null)
  // Reserve room for the widest possible readout so neighbours don't shift
  // sideways when it appears.
  const readoutWidth = `${`${total} of ${total}`.length}ch`

  return (
    <div className={cn("flex items-center gap-2", className)}>
      <div className="relative w-full sm:w-64">
        <Search
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-text-subtle"
        />
        <Input
          ref={inputRef}
          type="search"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && value) {
              event.preventDefault()
              onChange("")
            }
          }}
          placeholder="Filter cards…"
          aria-label="Filter cards"
          className="h-8 pr-8 pl-8 [&::-webkit-search-cancel-button]:hidden"
        />
        {value && (
          <button
            type="button"
            aria-label="Clear filter"
            onClick={() => {
              onChange("")
              // The button unmounts once the value is empty; keep focus in the box.
              inputRef.current?.focus()
            }}
            className="absolute top-1/2 right-1.5 inline-flex size-5 -translate-y-1/2 items-center justify-center rounded text-text-subtle hover:text-text-primary focus-visible:outline-2 focus-visible:outline-border-focus"
          >
            <X className="size-3.5" aria-hidden />
          </button>
        )}
      </div>
      <span
        aria-live="polite"
        style={{ minWidth: readoutWidth }}
        className="shrink-0 text-xs text-text-secondary tabular-nums"
      >
        {active ? `${shown} of ${total}` : ""}
      </span>
    </div>
  )
}
