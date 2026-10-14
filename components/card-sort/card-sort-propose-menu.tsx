"use client"

import { ArrowRight, MoreHorizontal, Undo2, Loader2 } from "lucide-react"

import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu"
import { ContextMenu, ContextMenuTrigger, ContextMenuContent } from "@/components/ui/context-menu"
import { Button } from "@/components/ui/button"
import type { SelectOption } from "@/lib/types"

/**
 * The "Propose move to…" menu, in one place, for both card sort views.
 *
 * The table and the kanban each offer this menu twice over — once on right-click,
 * once from a focusable button — which is four call sites for one set of items.
 * They all render ProposeMenuItems, so a proposal made from the kanban's kebab is
 * the same request as one made by right-clicking a table row. The brief asks for
 * the menu path and the drag path to agree; sharing the items (and the fetch
 * hook next door) is how that holds by construction rather than by coincidence.
 *
 * ── Why the kebab is not optional ──────────────────────────────────────────
 *
 * Drag-and-drop and right-click are both mouse gestures. Either one alone is an
 * accessibility regression, and dnd-kit's keyboard sensor does not close the gap:
 * it makes dragging possible with a keyboard, but only for someone who already
 * knows a card is draggable and which keys do it. ProposeMenuButton is a real
 * native <button> in tab order with an explicit accessible name, so the feature
 * is reachable by Tab from a standing start. Both are wired; neither substitutes
 * for the other.
 */

export type ProposeMenuProps = {
  /** Object title, used for the trigger's accessible name. */
  title: string
  options: readonly SelectOption[]
  /** The object's live official value — excluded from the targets offered. */
  currentValue: string | null
  /** The caller's own proposal, if any. Non-null enables Withdraw. */
  myProposedValue: string | null
  onPropose: (proposedValue: string) => void
  onWithdraw: () => void
}

/**
 * The items. Rendered inside either a DropdownMenuContent or a
 * ContextMenuContent — Base UI's ContextMenu reuses the Menu item components, so
 * the same items work in both without a parallel set.
 */
export function ProposeMenuItems({
  options,
  currentValue,
  myProposedValue,
  onPropose,
  onWithdraw,
}: Omit<ProposeMenuProps, "title">) {
  // Every bucket except the one the object is already in: proposing a no-op is
  // not an opinion, and the server rejects it as NO_OP anyway.
  const targets = options.filter((option) => option.value !== currentValue)

  return (
    <>
      {/*
        DropdownMenuLabel is a Base UI GroupLabel, which throws unless it has a
        Group ancestor — it labels the group, so there has to be one. The
        withdraw item sits outside the group because it is a different kind of
        action, not another bucket the label describes.
      */}
      <DropdownMenuGroup>
        <DropdownMenuLabel>Propose move to&hellip;</DropdownMenuLabel>
        {targets.map((option) => (
          <DropdownMenuItem key={option.value} onClick={() => onPropose(option.value)}>
            <ArrowRight className="size-4" /> {option.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuGroup>
      {myProposedValue && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onWithdraw}>
            <Undo2 className="size-4" /> Withdraw my proposal
          </DropdownMenuItem>
        </>
      )}
    </>
  )
}

/**
 * The keyboard- and click-reachable trigger: a real button with an accessible
 * name naming the object, so a screen reader user hears which card's menu they
 * are opening rather than a row of identical "More" buttons.
 */
export function ProposeMenuButton({ title, busy, ...items }: ProposeMenuProps & { busy?: boolean }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button size="icon" variant="ghost" aria-label={`Propose a move for ${title}`}>
            {busy ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <MoreHorizontal className="size-4" />
            )}
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="w-64">
        <ProposeMenuItems {...items} />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * Right-click surface wrapping arbitrary content — a table cell's text, or a
 * whole kanban card.
 */
export function ProposeContextMenu({
  title,
  children,
  className,
  ...items
}: ProposeMenuProps & { children: React.ReactNode; className?: string }) {
  return (
    <ContextMenu>
      <ContextMenuTrigger
        className={className}
        aria-label={`${title}. Right-click to propose a move.`}
      >
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ProposeMenuItems {...items} />
      </ContextMenuContent>
    </ContextMenu>
  )
}
