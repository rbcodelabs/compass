"use client"

import { ContextMenu as ContextMenuPrimitive } from "@base-ui/react/context-menu"

import { cn } from "@/lib/utils"

/**
 * Right-click menu, sharing its item vocabulary with the dropdown menu.
 *
 * This exists as a shared primitive for two reasons:
 *
 *   1. Stacking. The popup layer (80) is owned by components/ui/*, enforced by
 *      scripts/check-ui-layers.mjs. A feature component that hand-rolls
 *      `z-[80]` on a Positioner is a layers violation, and rightly so — the
 *      ladder in app/globals.css only stays coherent if the layers live in one
 *      place. card-sort-board.tsx used to do exactly that.
 *   2. One menu, two views. The card sort table and the card sort kanban both
 *      offer the same right-click menu. With the positioning and popup chrome
 *      here, the two call sites cannot drift apart visually or behaviorally.
 *
 * Items, labels, groups and separators are deliberately NOT re-exported: Base UI
 * ContextMenu and Menu share the same item components, so DropdownMenuItem and
 * friends work inside a ContextMenuContent unchanged. Duplicating them here
 * would create a second set to keep in sync for no benefit.
 */

function ContextMenu({ ...props }: ContextMenuPrimitive.Root.Props) {
  return <ContextMenuPrimitive.Root data-slot="context-menu" {...props} />
}

function ContextMenuTrigger({
  className,
  ...props
}: ContextMenuPrimitive.Trigger.Props) {
  return (
    <ContextMenuPrimitive.Trigger
      data-slot="context-menu-trigger"
      className={cn("cursor-context-menu", className)}
      {...props}
    />
  )
}

function ContextMenuContent({
  className,
  ...props
}: ContextMenuPrimitive.Popup.Props) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Positioner
        // Popup layer (80) — see the stacking-layer ladder in app/globals.css.
        // A context menu opened from inside a panel (60) or a dialog (70) has to
        // paint above it, or its items silently refuse clicks.
        className="isolate z-[80] outline-none"
      >
        <ContextMenuPrimitive.Popup
          data-slot="context-menu-content"
          className={cn(
            "min-w-56 origin-(--transform-origin) rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 duration-100 outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
            className
          )}
          {...props}
        />
      </ContextMenuPrimitive.Positioner>
    </ContextMenuPrimitive.Portal>
  )
}

export { ContextMenu, ContextMenuTrigger, ContextMenuContent }
