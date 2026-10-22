"use client"

// A labelled picker chip for the composer's footer tray (Agent, Model). One accessible pattern for both:
// a button (aria-haspopup=listbox) that opens a listbox of options. On desktop the list is an upward popover
// anchored to the chip; below the `sm` breakpoint it is a bottom sheet with 44px rows and a backdrop.
//
// Keyboard: Enter/Space/ArrowDown/ArrowUp on the chip open it; inside, ArrowUp/ArrowDown/Home/End move,
// Enter/Space select, Escape closes and returns focus to the chip.

import { useRef, useState, type KeyboardEvent, type ReactNode } from "react"
import { Check, ChevronDown } from "lucide-react"
import { cn } from "@/lib/utils"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet"
import { useNarrowViewport } from "@/components/agent/composer/use-narrow-viewport"

export type ChoiceOption = {
  value: string
  label: string
  /** Appends a "(shared)" marker that is never truncated, unlike the name. */
  shared?: boolean
}

type Props = {
  /** The visible word on the chip and the group title in the list, e.g. "Agent". */
  kind: string
  icon: ReactNode
  options: ChoiceOption[]
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  className?: string
}

function Name({ option }: { option: ChoiceOption }) {
  return (
    <span className="flex min-w-0">
      <span className="min-w-0 truncate" data-slot="choice-name">{option.label}</span>
      {option.shared && <span className="shrink-0 whitespace-pre text-muted-foreground" data-slot="choice-shared">{" (shared)"}</span>}
    </span>
  )
}

function OptionList(props: {
  kind: string
  options: ChoiceOption[]
  value: string
  onSelect: (value: string) => void
  sheet: boolean
  listRef: React.RefObject<HTMLDivElement | null>
}) {
  const { kind, options, value, onSelect, sheet, listRef } = props
  const rows = () => Array.from(listRef.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const list = rows()
    if (list.length === 0) return
    const at = list.indexOf(document.activeElement as HTMLElement)
    const focus = (i: number) => list[(i + list.length) % list.length]?.focus()
    if (e.key === "ArrowDown") { e.preventDefault(); focus(at + 1) }
    else if (e.key === "ArrowUp") { e.preventDefault(); focus(at < 0 ? list.length - 1 : at - 1) }
    else if (e.key === "Home") { e.preventDefault(); focus(0) }
    else if (e.key === "End") { e.preventDefault(); focus(list.length - 1) }
    else if ((e.key === "Enter" || e.key === " ") && at >= 0) { e.preventDefault(); list[at].click() }
  }
  return (
    // The listbox itself is not focusable: focus rides on the options (roving), so a screen reader reads the option, not the box.
    <div ref={listRef} role="listbox" aria-label={kind} onKeyDown={onKeyDown}>
      {options.map((option) => {
        const selected = option.value === value
        return (
          <div
            key={option.value}
            role="option"
            aria-selected={selected}
            aria-label={option.shared ? `${option.label} (shared)` : option.label}
            tabIndex={-1}
            data-value={option.value}
            onClick={() => onSelect(option.value)}
            className={cn(
              "flex cursor-pointer items-center gap-2 rounded-lg px-2.5 text-[13px] outline-none hover:bg-muted focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              sheet ? "h-11 text-[15px]" : "h-8",
              selected && "font-medium",
            )}
          >
            <Name option={option} />
            <Check className={cn("ml-auto size-4 shrink-0 text-primary", !selected && "invisible")} aria-hidden="true" />
          </div>
        )
      })}
    </div>
  )
}

export function ChoiceChip({ kind, icon, options, value, onChange, disabled = false, className }: Props) {
  const [openState, setOpen] = useState(false)
  const narrow = useNarrowViewport()
  const listRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  // A chip that becomes disabled (a run starts) must not leave its list open.
  const open = openState && !disabled
  const selected = options.find((option) => option.value === value) ?? options[0]
  const accessibleName = `${kind}: ${selected?.label ?? ""}${selected?.shared ? " (shared)" : ""}`

  function select(next: string) {
    if (next !== value) onChange(next)
    setOpen(false)
    // The popup unmounts with focus inside it; hand focus back to the chip explicitly rather than rely on the primitive.
    requestAnimationFrame(() => triggerRef.current?.focus())
  }
  const focusSelected = () => listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]') ?? listRef.current?.querySelector<HTMLElement>('[role="option"]') ?? undefined

  const triggerClass = cn(
    "inline-flex h-7 min-w-0 max-w-full items-center gap-1.5 rounded-lg border border-border bg-card px-1.5 text-[12.5px] text-foreground outline-none transition-colors",
    "hover:not-disabled:border-border-strong focus-visible:ring-2 focus-visible:ring-ring aria-expanded:border-ring aria-expanded:ring-[3px] aria-expanded:ring-ring/20",
    "disabled:cursor-not-allowed disabled:opacity-55 motion-reduce:transition-none",
    "max-sm:h-9 @max-md/composer:w-full",
    className,
  )
  const triggerBody = (
    <>
      <span className="hidden shrink-0 text-[10px] font-semibold tracking-[0.07em] text-muted-foreground uppercase @md/composer:inline">{kind}</span>
      <span className="shrink-0 text-muted-foreground [&_svg]:size-[15px]" aria-hidden="true">{icon}</span>
      <span className="flex min-w-0 font-medium"><Name option={selected ?? { value: "", label: "" }} /></span>
      <ChevronDown className="size-3.5 shrink-0 text-muted-foreground @max-md/composer:ml-auto" aria-hidden="true" />
    </>
  )
  const onTriggerKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault()
      setOpen(true)
    }
  }
  // Shrinkable: a long agent name must truncate inside the card, never push the tray past its edge.
  const wrap = "flex min-w-0 flex-[0_1_auto] @max-md/composer:flex-1"

  if (narrow) {
    return (
      <div className={wrap}>
        <button
          ref={triggerRef}
          type="button"
          className={triggerClass}
          disabled={disabled}
          aria-label={accessibleName}
          aria-haspopup="listbox"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          onKeyDown={onTriggerKeyDown}
        >
          {triggerBody}
        </button>
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetContent side="bottom" showCloseButton={false} initialFocus={focusSelected} className="max-h-[80dvh] gap-0 overflow-auto rounded-t-2xl p-2 pb-6" data-testid={`${kind.toLowerCase()}-sheet`}>
            <div aria-hidden="true" className="mx-auto mt-0.5 mb-2 h-1 w-9 rounded bg-border-strong" />
            <SheetTitle className="px-2.5 pt-2 pb-1 text-[10.5px] font-semibold tracking-[0.07em] text-muted-foreground uppercase">{kind}</SheetTitle>
            <OptionList kind={kind} options={options} value={value} onSelect={select} sheet listRef={listRef} />
          </SheetContent>
        </Sheet>
      </div>
    )
  }

  return (
    <div className={wrap}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          ref={triggerRef}
          className={triggerClass}
          disabled={disabled}
          aria-label={accessibleName}
          aria-haspopup="listbox"
          onKeyDown={onTriggerKeyDown}
        >
          {triggerBody}
        </PopoverTrigger>
        <PopoverContent aria-label={`${kind} options`} side="top" align="start" sideOffset={8} initialFocus={focusSelected} className="max-h-[min(360px,var(--available-height))] w-[min(340px,calc(100vw-1.5rem))] overflow-auto rounded-xl border border-border bg-popover p-1.5 text-popover-foreground shadow-lg">
          <div className="px-2.5 pt-2 pb-1 text-[10.5px] font-semibold tracking-[0.07em] text-muted-foreground uppercase">{kind}</div>
          <OptionList kind={kind} options={options} value={value} onSelect={select} sheet={false} listRef={listRef} />
        </PopoverContent>
      </Popover>
    </div>
  )
}
