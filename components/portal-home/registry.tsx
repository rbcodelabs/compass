import type { ReactNode } from "react"
import type { PortalHomeWidget } from "@/lib/portal-home/schema"
import type { WidgetResolution } from "@/lib/portal-home/data"
import type { HomeOptions } from "./types"
import { AnnouncementForm, AnnouncementRenderer } from "./widgets/announcement"
import { KeyLinksForm, KeyLinksRenderer } from "./widgets/key-links"
import { RoadmapSpotlightForm, RoadmapSpotlightRenderer } from "./widgets/roadmap-spotlight"
import { FeedbackCtaForm, FeedbackCtaRenderer } from "./widgets/feedback-cta"
import { RecentUpdatesForm, RecentUpdatesRenderer } from "./widgets/recent-updates"
import { RichTextForm, RichTextRenderer } from "./widgets/rich-text"

/**
 * The UI half of the widget registry (the data half is lib/portal-home/schema.ts
 * WIDGET_DEFINITIONS). Exhaustive switches: adding a type to the Zod union fails
 * to compile here until it has a renderer and a config form.
 */

/** Renders the widget body for a RESOLVED widget. Returns null when the resolution does not match. */
export function renderWidgetBody(widget: PortalHomeWidget, resolution: Extract<WidgetResolution, { available: true }>): ReactNode {
  const data = resolution.data
  switch (widget.type) {
    case "announcement":
      return <AnnouncementRenderer config={widget.config} data={data} />
    case "rich_text":
      return <RichTextRenderer config={widget.config} data={data} />
    case "key_links":
      return data.type === "key_links" ? <KeyLinksRenderer config={widget.config} data={data} /> : null
    case "roadmap_spotlight":
      return data.type === "roadmap_spotlight" ? <RoadmapSpotlightRenderer config={widget.config} data={data} /> : null
    case "recent_updates":
      return data.type === "recent_updates" ? <RecentUpdatesRenderer config={widget.config} data={data} /> : null
    case "feedback_cta":
      return data.type === "feedback_cta" ? <FeedbackCtaRenderer config={widget.config} data={data} /> : null
  }
}

/** The right-hand config form for a widget. `onChange` receives the whole widget with the new config. */
export function renderWidgetForm(widget: PortalHomeWidget, onChange: (widget: PortalHomeWidget) => void, options: HomeOptions | null): ReactNode {
  switch (widget.type) {
    case "announcement":
      return <AnnouncementForm config={widget.config} options={options} onChange={(config) => onChange({ ...widget, config })} />
    case "key_links":
      return <KeyLinksForm config={widget.config} options={options} onChange={(config) => onChange({ ...widget, config })} />
    case "roadmap_spotlight":
      return <RoadmapSpotlightForm config={widget.config} options={options} onChange={(config) => onChange({ ...widget, config })} />
    case "feedback_cta":
      return <FeedbackCtaForm config={widget.config} options={options} onChange={(config) => onChange({ ...widget, config })} />
    case "recent_updates":
      return <RecentUpdatesForm config={widget.config} options={options} onChange={(config) => onChange({ ...widget, config })} />
    case "rich_text":
      return <RichTextForm config={widget.config} options={options} onChange={(config) => onChange({ ...widget, config })} />
  }
}
