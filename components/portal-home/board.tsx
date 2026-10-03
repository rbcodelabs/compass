import type { ReactNode } from "react"
import type { PortalHomeWidget, WidgetSize } from "@/lib/portal-home/schema"
import type { WidgetResolution } from "@/lib/portal-home/data"
import { renderWidgetBody } from "./registry"
import { cn } from "@/lib/utils"

/**
 * 6-column grid: S = 2/6, M = 3/6, L = 6/6 from md up; a single column below.
 * Full class strings (not interpolated) so Tailwind sees them.
 */
export const SIZE_CLASS: Record<WidgetSize, string> = {
  S: "md:col-span-2",
  M: "md:col-span-3",
  L: "md:col-span-6",
}

export const BOARD_CLASS = "grid grid-cols-1 gap-4 md:grid-cols-6"

/** Customer board: server-renderable, widgets already filtered and resolved by the server. */
export function PortalHomeBoard({ widgets, resolved }: { widgets: PortalHomeWidget[]; resolved: Record<string, WidgetResolution> }) {
  return (
    <div className={BOARD_CLASS} data-testid="portal-home-board">
      {widgets.map((widget) => {
        const resolution = resolved[widget.id]
        if (!resolution?.available) return null
        const body = renderWidgetBody(widget, resolution)
        if (!body) return null
        return (
          <section key={widget.id} aria-label={widget.type.replace("_", " ")} data-widget-type={widget.type} className={cn("min-w-0", SIZE_CLASS[widget.size])}>
            {body}
          </section>
        )
      })}
    </div>
  )
}

export function EmptyHome({ children }: { children?: ReactNode }) {
  return <div className="rounded-xl border border-dashed border-border-strong bg-surface-inset px-6 py-12 text-center text-sm text-text-subtle">{children ?? "Nothing here yet."}</div>
}
