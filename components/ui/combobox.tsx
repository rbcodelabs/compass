"use client"

import * as React from "react"
import { Combobox as ComboboxPrimitive } from "@base-ui/react/combobox"

import { cn } from "@/lib/utils"
import { ChevronDownIcon, CheckIcon } from "lucide-react"

export type ComboboxItemData = {
  value: string
  label: string
  render?: React.ReactNode
}

type ComboboxProps = {
  items: ComboboxItemData[]
  value?: string | null
  onValueChange?: (value: string | null) => void
  disabled?: boolean
  /** Controlled open state — use with a triggerless, anchored ComboboxContent. */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  children: React.ReactNode
}

function Combobox({ items, value, onValueChange, disabled, open, onOpenChange, children }: ComboboxProps) {
  const selectedItem = React.useMemo(
    () => (value != null ? (items.find((item) => item.value === value) ?? null) : null),
    [items, value]
  )

  return (
    <ComboboxPrimitive.Root
      items={items}
      value={selectedItem}
      onValueChange={(item) => onValueChange?.(item ? item.value : null)}
      disabled={disabled}
      open={open}
      onOpenChange={onOpenChange ? (nextOpen) => onOpenChange(nextOpen) : undefined}
      autoHighlight
    >
      {children}
    </ComboboxPrimitive.Root>
  )
}

function ComboboxTrigger({
  className,
  size = "default",
  variant = "default",
  children,
  ...props
}: ComboboxPrimitive.Trigger.Props & {
  size?: "sm" | "default"
  variant?: "default" | "inline"
}) {
  return (
    <ComboboxPrimitive.Trigger
      data-slot="combobox-trigger"
      data-size={size}
      className={cn(
        variant === "inline"
          ? "w-auto h-auto border-0 p-0 shadow-none bg-transparent text-xs text-muted-foreground/60 outline-none select-none hover:text-muted-foreground focus-visible:ring-0 disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:hidden gap-0"
          : "flex w-fit items-center justify-between gap-1.5 rounded-lg border border-input bg-transparent py-2 pr-2 pl-2.5 text-sm whitespace-nowrap transition-colors outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 data-placeholder:text-muted-foreground data-[size=default]:h-8 data-[size=sm]:h-7 data-[size=sm]:rounded-[min(var(--radius-md),10px)] *:data-[slot=combobox-value]:line-clamp-1 *:data-[slot=combobox-value]:flex *:data-[slot=combobox-value]:items-center *:data-[slot=combobox-value]:gap-1.5 dark:bg-input/30 dark:hover:bg-input/50 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    >
      {children}
      {variant === "default" && (
        <ComboboxPrimitive.Icon
          render={
            <ChevronDownIcon className="pointer-events-none size-4 text-muted-foreground" />
          }
        />
      )}
    </ComboboxPrimitive.Trigger>
  )
}

function ComboboxValue({
  className,
  placeholder,
}: {
  className?: string
  placeholder?: React.ReactNode
}) {
  return (
    <span data-slot="combobox-value" className={cn("flex flex-1 text-left", className)}>
      <ComboboxPrimitive.Value placeholder={placeholder}>
        {(item: ComboboxItemData | null) => item?.render ?? item?.label ?? placeholder}
      </ComboboxPrimitive.Value>
    </span>
  )
}

function ComboboxContent({
  className,
  emptyMessage = "No matches.",
  inputPlaceholder = "Search…",
  side = "bottom",
  sideOffset = 4,
  align = "center",
  alignOffset = 0,
  anchor,
  ...props
}: Omit<ComboboxPrimitive.Popup.Props, "children"> &
  Pick<
    ComboboxPrimitive.Positioner.Props,
    "align" | "alignOffset" | "side" | "sideOffset" | "anchor"
  > & {
    emptyMessage?: React.ReactNode
    inputPlaceholder?: string
  }) {
  return (
    <ComboboxPrimitive.Portal>
      <ComboboxPrimitive.Positioner
        side={side}
        sideOffset={sideOffset}
        align={align}
        alignOffset={alignOffset}
        anchor={anchor}
        // z-[70], not z-50: matches SelectContent's Positioner (see
        // components/ui/select.tsx) for the same reason — the Positioner is
        // the portal's fixed-position root, so this value alone decides
        // whether the popup paints above or below other overlays. Entity
        // detail panels raise their SheetContent to z-[60] (panel-shell.tsx),
        // which left in-panel Comboboxes (InlineAssigneeField, SquadPicker)
        // rendering with correct ARIA state but *underneath* the sheet —
        // present in the DOM, but invisible and swallowing no clicks (the
        // panel content beneath intercepted them instead). 70 keeps this
        // transient popup layer above the panel layer, consistent with
        // Select everywhere else in the app.
        className="isolate z-[70]"
      >
        <ComboboxPrimitive.Popup
          data-slot="combobox-content"
          className={cn(
            "relative isolate z-50 flex max-h-(--available-height) w-(--anchor-width) min-w-56 origin-(--transform-origin) flex-col overflow-hidden rounded-lg bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10 duration-100 data-[side=bottom]:slide-in-from-top-2 data-[side=inline-end]:slide-in-from-left-2 data-[side=inline-start]:slide-in-from-right-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
            className
          )}
          {...props}
        >
          <div className="border-b border-border p-1">
            <ComboboxPrimitive.Input
              autoFocus
              placeholder={inputPlaceholder}
              className="w-full rounded-md bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>
          <ComboboxPrimitive.Empty className="px-2.5 py-6 text-center text-sm text-muted-foreground">
            {emptyMessage}
          </ComboboxPrimitive.Empty>
          <ComboboxPrimitive.List className="scroll-my-1 overflow-x-hidden overflow-y-auto p-1">
            {(item: ComboboxItemData) => (
              <ComboboxItem key={item.value} value={item}>
                {item.render ?? item.label}
              </ComboboxItem>
            )}
          </ComboboxPrimitive.List>
        </ComboboxPrimitive.Popup>
      </ComboboxPrimitive.Positioner>
    </ComboboxPrimitive.Portal>
  )
}

function ComboboxItem({ className, children, ...props }: ComboboxPrimitive.Item.Props) {
  return (
    <ComboboxPrimitive.Item
      data-slot="combobox-item"
      className={cn(
        "relative flex w-full cursor-default items-center gap-1.5 rounded-md py-1 pr-8 pl-1.5 text-sm outline-hidden select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    >
      <span className="flex flex-1 shrink-0 items-center gap-2 whitespace-nowrap">
        {children}
      </span>
      <ComboboxPrimitive.ItemIndicator
        render={
          <span className="pointer-events-none absolute right-2 flex size-4 items-center justify-center" />
        }
      >
        <CheckIcon className="pointer-events-none" />
      </ComboboxPrimitive.ItemIndicator>
    </ComboboxPrimitive.Item>
  )
}

export { Combobox, ComboboxContent, ComboboxItem, ComboboxTrigger, ComboboxValue }
