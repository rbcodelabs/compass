"use client"

import * as React from "react"
import { MoreHorizontal } from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"

export type CardMenuItem = {
  label: string
  onClick: (e: React.MouseEvent) => void
  destructive?: boolean
  disabled?: boolean
  separator?: boolean // render a separator BEFORE this item
}

export function CardMenu({ items, className }: { items: CardMenuItem[]; className?: string }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          "shrink-0 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity",
          "inline-flex size-6 items-center justify-center rounded-[min(var(--radius-md),10px)]",
          "text-muted-foreground hover:text-foreground hover:bg-muted",
          "border border-transparent bg-transparent",
          "disabled:pointer-events-none disabled:opacity-50",
          className
        )}
        onClick={(e) => e.stopPropagation()}
        aria-label="Card actions"
      >
        <MoreHorizontal className="size-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        {items.map((item, i) => (
          <React.Fragment key={i}>
            {item.separator && <DropdownMenuSeparator />}
            <DropdownMenuItem
              disabled={item.disabled}
              className={cn(item.destructive && "text-destructive focus:text-destructive")}
              onClick={(e) => { e.stopPropagation(); item.onClick(e) }}
            >
              {item.label}
            </DropdownMenuItem>
          </React.Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
