import type { ReactNode } from "react"
import type { PortalHomeWidget, WidgetSize } from "@/lib/portal-home/schema"
import type { WidgetResolution } from "@/lib/portal-home/data"
import { coerceStoredTemplate, type PortalTemplate } from "@/lib/portal-home/templates"
import { renderWidgetBody } from "./registry"
import { TEMPLATE_GRID, TEMPLATE_SPAN, splitHubRegions, templateAttrs } from "./templates/arrange"
import { cn } from "@/lib/utils"

/** The pre-template 6-column arrangement: still what the team home (no template) renders. */
export const BOARD_CLASS = "grid grid-cols-1 gap-4 md:grid-cols-6"
export const SIZE_CLASS: Record<WidgetSize, string> = { S: "md:col-span-2", M: "md:col-span-3", L: "md:col-span-6" }

/** Wraps widgets so the `group-data-[tpl=...]/home` card styles apply. Render any board inside one of these. */
export function TemplateScope({ template, className, children, ...rest }: { template: PortalTemplate | string | null | undefined; className?: string; children: ReactNode } & Record<string, unknown>) {
  return (
    <div {...rest} {...templateAttrs(template)} className={cn("group/home", className)}>
      {children}
    </div>
  )
}

interface BoardItem {
  widget: PortalHomeWidget
  body: ReactNode
}

function Slot({ item, className }: { item: BoardItem; className?: string }) {
  const { widget, body } = item
  return (
    <section
      id={widget.type === "docs" ? "docs" : undefined}
      aria-label={widget.type.replace("_", " ")}
      data-widget-type={widget.type}
      className={cn("min-w-0 scroll-mt-20", className)}
    >
      {body}
    </section>
  )
}

/**
 * Customer board: server-renderable, widgets already filtered and resolved by the server. `template` decides
 * the arrangement and card style (omitted: the legacy board); the widget list, sizes and order are the same for every template.
 */
export function PortalHomeBoard({ widgets, resolved, template }: { widgets: PortalHomeWidget[]; resolved: Record<string, WidgetResolution>; template?: PortalTemplate | string | null }) {
  // No template (the team home): the original 6-column board, unstyled by any template.
  const active = coerceStoredTemplate(template)
  const items: BoardItem[] = []
  for (const widget of widgets) {
    const resolution = resolved[widget.id]
    if (!resolution?.available) continue
    const body = renderWidgetBody(widget, resolution)
    if (!body) continue
    items.push({ widget, body })
  }

  if (template === undefined) {
    return (
      <div className={BOARD_CLASS} data-testid="portal-home-board">
        {items.map((item) => <Slot key={item.widget.id} item={item} className={SIZE_CLASS[item.widget.size]} />)}
      </div>
    )
  }

  if (active === "docs_hub") {
    const { main, rail } = splitHubRegions(items.map((item) => item.widget))
    const byId = new Map(items.map((item) => [item.widget.id, item]))
    const pick = (list: PortalHomeWidget[]) => list.map((w) => byId.get(w.id)!)
    return (
      <TemplateScope template={active} data-testid="portal-home-board" className={cn("grid grid-cols-1 gap-8", rail.length > 0 && main.length > 0 && "lg:grid-cols-[minmax(0,1fr)_21rem] lg:items-start")}>
        {main.length > 0 ? (
          <div className="flex min-w-0 flex-col gap-5" data-region="main">
            {pick(main).map((item) => <Slot key={item.widget.id} item={item} />)}
          </div>
        ) : null}
        {rail.length > 0 ? (
          <div className="flex min-w-0 flex-col gap-5" data-region="rail">
            {pick(rail).map((item) => <Slot key={item.widget.id} item={item} />)}
          </div>
        ) : null}
      </TemplateScope>
    )
  }

  return (
    <TemplateScope template={active} data-testid="portal-home-board" className={TEMPLATE_GRID[active]}>
      {items.map((item) => <Slot key={item.widget.id} item={item} className={TEMPLATE_SPAN[active][item.widget.size]} />)}
    </TemplateScope>
  )
}

export function EmptyHome({ children }: { children?: ReactNode }) {
  return <div className="rounded-xl border border-dashed border-border-strong bg-surface-inset px-6 py-12 text-center text-sm text-text-subtle">{children ?? "Nothing here yet."}</div>
}
