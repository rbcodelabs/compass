import type { PortalHomeWidget, WidgetSize } from "@/lib/portal-home/schema"
import { coerceStoredTemplate, type PortalTemplate } from "@/lib/portal-home/templates"

/**
 * How each template arranges the SAME widget list. The widget list/size/order stay the source of truth; a
 * template only decides columns and regions. Full class strings (not interpolated) so Tailwind sees them.
 */

/** Short, attribute-safe key used by the `group-data-[tpl=...]/home` styling variants. */
export const TEMPLATE_KEY: Record<PortalTemplate, "editorial" | "bento" | "shell" | "hub"> = {
  editorial: "editorial",
  bento: "bento",
  shell: "shell",
  docs_hub: "hub",
}

export const TEMPLATE_GRID: Record<PortalTemplate, string> = {
  editorial: "mx-auto grid w-full max-w-3xl grid-cols-1 gap-6",
  bento: "grid grid-cols-1 gap-5 md:grid-cols-6 md:grid-flow-dense",
  shell: "grid grid-cols-1 gap-4 md:grid-cols-2",
  // The customer hub is two regions (see splitHubRegions); the editor canvas uses this single sortable grid.
  docs_hub: "grid grid-cols-1 gap-5 md:grid-cols-6",
}

export const TEMPLATE_SPAN: Record<PortalTemplate, Record<WidgetSize, string>> = {
  editorial: { S: "", M: "", L: "" },
  bento: { S: "md:col-span-2", M: "md:col-span-3", L: "md:col-span-6" },
  shell: { S: "", M: "", L: "md:col-span-2" },
  docs_hub: { S: "md:col-span-2", M: "md:col-span-3", L: "md:col-span-6" },
}

/** The wrapper's data attributes: `tpl` picks the card style, `hero` says whether announcement cards are solid or light. */
export function templateAttrs(template: PortalTemplate | string | null | undefined): { "data-tpl": string; "data-hero": "solid" | "light" } {
  const resolved = coerceStoredTemplate(template)
  return { "data-tpl": TEMPLATE_KEY[resolved], "data-hero": resolved === "bento" ? "solid" : "light" }
}

/** Rail widgets: link lists, the feedback prompt and anything the admin sized Small. Docs always lead the main column. */
export function splitHubRegions<T extends Pick<PortalHomeWidget, "type" | "size">>(widgets: readonly T[]): { main: T[]; rail: T[] } {
  const main: T[] = []
  const rail: T[] = []
  for (const widget of widgets) {
    const toRail = widget.type !== "docs" && (widget.type === "key_links" || widget.type === "feedback_cta" || widget.size === "S")
    ;(toRail ? rail : main).push(widget)
  }
  // Stable: docs first, everything else keeps its relative order.
  return { main: [...main.filter((w) => w.type === "docs"), ...main.filter((w) => w.type !== "docs")], rail }
}
