"use client"

import * as React from "react"
import { Select as SelectPrimitive } from "@base-ui/react/select"

import { cn } from "@/lib/utils"
import { ChevronDownIcon, CheckIcon, ChevronUpIcon } from "lucide-react"

type SelectItemLabels = Record<string, string>

/**
 * Flattens a `SelectItem`'s children to the text React would render, or returns
 * `null` if the label is richer than that (an icon, a badge, a nested element).
 *
 * Only text labels are auto-derived. A rich label cannot be reduced to a stable
 * string, and a call site that wants one on the trigger should pass `items` or
 * the `<SelectValue>{fn}</SelectValue>` formatter explicitly.
 */
function labelText(node: React.ReactNode): string | null {
  if (node == null || typeof node === "boolean") return ""
  if (typeof node === "string") return node
  if (typeof node === "number") return String(node)
  if (Array.isArray(node)) {
    let text = ""
    for (const part of node) {
      const partText = labelText(part as React.ReactNode)
      if (partText === null) return null
      text += partText
    }
    return text
  }
  return null
}

/**
 * Walks a subtree collecting `<SelectItem value>` -> label pairs.
 *
 * Recurses through `SelectContent`, `SelectGroup`, fragments and arrays
 * produced by `.map()`, so items are found wherever a call site nests them.
 * Items are matched by referential identity against the local `SelectItem`
 * wrapper — every call site imports it from this module, so identity holds.
 */
function collectSelectItemLabels(
  children: React.ReactNode,
  into: SelectItemLabels,
): void {
  React.Children.forEach(children, (child) => {
    if (!React.isValidElement(child)) return
    const props = child.props as {
      value?: unknown
      children?: React.ReactNode
    }

    if (child.type === SelectItem) {
      // A null/undefined-valued item is Base UI's placeholder channel
      // (`hasNullItemLabel`): giving it a label in `items` makes Base UI treat
      // that label as the placeholder. Skip them so placeholder behaviour and
      // the `data-placeholder` styling hook stay exactly as they are today.
      if (props.value != null) {
        const text = labelText(props.children)
        if (text !== null) into[String(props.value)] = text
      }
      // A SelectItem's children *are* the label — nothing further to collect.
      return
    }

    collectSelectItemLabels(props.children, into)
  })
}

/**
 * `Select` — Base UI's `Select.Root` with Radix-compatible `<SelectValue />`.
 *
 * Base UI's `<Select.Value>` is **not** Radix's. Radix renders the selected
 * item's rendered text; Base UI, per its docs, "renders the raw value of the
 * selected item" and only resolves a human label when `Select.Root` is handed
 * an `items` prop (a value -> label record, consumed by `resolveSelectedLabel`).
 *
 * Every call site in this app is written in Radix/shadcn idiom —
 * `<SelectItem value="ADMIN">Admin</SelectItem>` next to a bare
 * `<SelectValue />` — so the *option list* read correctly while the *closed
 * trigger* rendered the raw constant: `ADMIN`, `IN_PROGRESS`, `URGENT`, or a
 * bare UUID for entity pickers. It looked intermittent because Base UI can
 * recover a label from an item that has already mounted once the popup has been
 * opened, but a fresh page load always showed the raw value.
 *
 * Rather than require ~24 call sites to each remember `items`, this wrapper
 * derives it from the children it was already given. An explicitly passed
 * `items` always wins, so call sites whose selectable values do not appear in
 * the children (async-loaded options, grouped data) keep full control —
 * see `components/scoring-models/workspace-scoring-panel.tsx`. The
 * `<SelectValue>{(value) => …}</SelectValue>` formatter form also still wins,
 * because Base UI prefers `Value`'s children over the resolved label — see
 * `components/decisions/decision-follow-through.tsx`.
 */
function Select<Value, Multiple extends boolean | undefined = false>({
  items,
  children,
  ...props
}: SelectPrimitive.Root.Props<Value, Multiple>) {
  // Walking `children` produces a fresh object every render, and every other
  // input to Base UI's internal store is memoized — so an unstable `items`
  // identity would be the one thing re-broadcasting store state on each parent
  // render. It does not loop (subscribers select primitives and bail out), but
  // it is pointless work. Serializing the pairs gives a value-equal dependency,
  // so the object handed to Base UI only changes when a label actually does.
  // An empty result means "no text labels found" (async options, rich labels):
  // pass `undefined`, not `{}`, so Base UI's default path is untouched.
  let signature = ""
  if (items === undefined) {
    const collected: SelectItemLabels = {}
    collectSelectItemLabels(children, collected)
    if (Object.keys(collected).length > 0) signature = JSON.stringify(collected)
  }

  const derived = React.useMemo(
    () => (signature ? (JSON.parse(signature) as SelectItemLabels) : undefined),
    [signature]
  )

  return (
    <SelectPrimitive.Root {...props} items={items ?? derived}>
      {children}
    </SelectPrimitive.Root>
  )
}

function SelectGroup({ className, ...props }: SelectPrimitive.Group.Props) {
  return (
    <SelectPrimitive.Group
      data-slot="select-group"
      className={cn("scroll-my-1 p-1", className)}
      {...props}
    />
  )
}

function SelectValue({ className, ...props }: SelectPrimitive.Value.Props) {
  return (
    <SelectPrimitive.Value
      data-slot="select-value"
      className={cn("flex flex-1 text-left", className)}
      {...props}
    />
  )
}

function SelectTrigger({
  className,
  size = "default",
  children,
  ...props
}: SelectPrimitive.Trigger.Props & {
  size?: "sm" | "default"
}) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      data-size={size}
      className={cn(
        "flex w-fit items-center justify-between gap-1.5 rounded-lg border border-input bg-transparent py-2 pr-2 pl-2.5 text-sm whitespace-nowrap transition-colors outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 data-placeholder:text-muted-foreground data-[size=default]:h-8 data-[size=sm]:h-7 data-[size=sm]:rounded-[min(var(--radius-md),10px)] *:data-[slot=select-value]:line-clamp-1 *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-1.5 dark:bg-input/30 dark:hover:bg-input/50 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon
        render={
          <ChevronDownIcon className="pointer-events-none size-4 text-muted-foreground" />
        }
      />
    </SelectPrimitive.Trigger>
  )
}

function SelectContent({
  className,
  children,
  side = "bottom",
  sideOffset = 4,
  align = "center",
  alignOffset = 0,
  alignItemWithTrigger = true,
  ...props
}: SelectPrimitive.Popup.Props &
  Pick<
    SelectPrimitive.Positioner.Props,
    "align" | "alignOffset" | "side" | "sideOffset" | "alignItemWithTrigger"
  >) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Positioner
        side={side}
        sideOffset={sideOffset}
        align={align}
        alignOffset={alignOffset}
        alignItemWithTrigger={alignItemWithTrigger}
        // Popup layer (80) — see the stacking-layer ladder in app/globals.css.
        // The Positioner is the portal's fixed-position root, so this value
        // alone decides whether the listbox paints above or below other
        // overlays. At z-50 every in-panel Select's options rendered
        // *underneath* the panel sheet (panel layer, 60) — visible, but
        // swallowing mouse clicks, so a status could only be changed by
        // keyboard. 80 keeps the transient popup layer above every surface,
        // including the dialog layer (70) that Selects are also opened from.
        //
        // The detail panel now has a second mode: pinned, where it is an
        // in-flow <aside> with z-auto rather than a z-60 Sheet (see
        // components/panels/panel-shell.tsx). That mode raises no stacking
        // context for this popup to clear, so it is strictly easier than the
        // overlay case this value was chosen for — 80 covers both, and the
        // value must not be lowered on the strength of the pinned case alone.
        // e2e/functional/specs/detail-panel-pin.spec.ts pins a Select inside a
        // pinned panel and asserts it is still clickable.
        className="isolate z-[80]"
      >
        <SelectPrimitive.Popup
          data-slot="select-content"
          data-align-trigger={alignItemWithTrigger}
          className={cn("relative isolate z-50 max-h-(--available-height) w-(--anchor-width) min-w-36 origin-(--transform-origin) overflow-x-hidden overflow-y-auto rounded-lg bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10 duration-100 data-[align-trigger=true]:animate-none data-[side=bottom]:slide-in-from-top-2 data-[side=inline-end]:slide-in-from-left-2 data-[side=inline-start]:slide-in-from-right-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95", className )}
          {...props}
        >
          <SelectScrollUpButton />
          <SelectPrimitive.List>{children}</SelectPrimitive.List>
          <SelectScrollDownButton />
        </SelectPrimitive.Popup>
      </SelectPrimitive.Positioner>
    </SelectPrimitive.Portal>
  )
}

function SelectLabel({
  className,
  ...props
}: SelectPrimitive.GroupLabel.Props) {
  return (
    <SelectPrimitive.GroupLabel
      data-slot="select-label"
      className={cn("px-1.5 py-1 text-xs text-muted-foreground", className)}
      {...props}
    />
  )
}

function SelectItem({
  className,
  children,
  ...props
}: SelectPrimitive.Item.Props) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(
        "relative flex w-full cursor-default items-center gap-1.5 rounded-md py-1 pr-8 pl-1.5 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground not-data-[variant=destructive]:focus:**:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 *:[span]:last:flex *:[span]:last:items-center *:[span]:last:gap-2",
        className
      )}
      {...props}
    >
      <SelectPrimitive.ItemText className="flex flex-1 shrink-0 gap-2 whitespace-nowrap">
        {children}
      </SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator
        render={
          <span className="pointer-events-none absolute right-2 flex size-4 items-center justify-center" />
        }
      >
        <CheckIcon className="pointer-events-none" />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  )
}

function SelectSeparator({
  className,
  ...props
}: SelectPrimitive.Separator.Props) {
  return (
    <SelectPrimitive.Separator
      data-slot="select-separator"
      className={cn("pointer-events-none -mx-1 my-1 h-px bg-border", className)}
      {...props}
    />
  )
}

function SelectScrollUpButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollUpArrow>) {
  return (
    <SelectPrimitive.ScrollUpArrow
      data-slot="select-scroll-up-button"
      className={cn(
        "top-0 z-10 flex w-full cursor-default items-center justify-center bg-popover py-1 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    >
      <ChevronUpIcon
      />
    </SelectPrimitive.ScrollUpArrow>
  )
}

function SelectScrollDownButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollDownArrow>) {
  return (
    <SelectPrimitive.ScrollDownArrow
      data-slot="select-scroll-down-button"
      className={cn(
        "bottom-0 z-10 flex w-full cursor-default items-center justify-center bg-popover py-1 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    >
      <ChevronDownIcon
      />
    </SelectPrimitive.ScrollDownArrow>
  )
}

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
}
