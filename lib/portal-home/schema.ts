import { z } from "zod"
import { announcementConfig, announcementDefinition } from "./widgets/announcement"
import { keyLinksConfig, keyLinksDefinition } from "./widgets/key-links"
import { roadmapSpotlightConfig, roadmapSpotlightDefinition } from "./widgets/roadmap-spotlight"
import { feedbackCtaConfig, feedbackCtaDefinition } from "./widgets/feedback-cta"
import { recentUpdatesConfig, recentUpdatesDefinition } from "./widgets/recent-updates"
import { richTextConfig, richTextDefinition } from "./widgets/rich-text"

/**
 * Portal Home widget model. Client-safe: Zod and plain data only, so the admin
 * editor, the API routes and the server resolvers share one definition.
 */

export const WIDGET_SIZES = ["S", "M", "L"] as const
export type WidgetSize = (typeof WIDGET_SIZES)[number]

/**
 * "segments" is stored so layouts authored today survive when segments ship, but
 * v1 treats it as disabled: no customer is in any segment, so such a widget is
 * never shown to customers (see visibility.ts).
 */
export const WIDGET_VISIBILITIES = ["everyone", "signed_in", "segments"] as const
export type WidgetVisibility = (typeof WIDGET_VISIBILITIES)[number]

export const MAX_WIDGETS = 24

const base = {
  id: z.string().trim().min(1).max(64),
  size: z.enum(WIDGET_SIZES),
  order: z.number().int().min(0).max(10_000),
  visibility: z.enum(WIDGET_VISIBILITIES).default("everyone"),
}

export const widgetSchema = z.discriminatedUnion("type", [
  z.object({ ...base, type: z.literal("announcement"), config: announcementConfig }),
  z.object({ ...base, type: z.literal("key_links"), config: keyLinksConfig }),
  z.object({ ...base, type: z.literal("roadmap_spotlight"), config: roadmapSpotlightConfig }),
  z.object({ ...base, type: z.literal("feedback_cta"), config: feedbackCtaConfig }),
  z.object({ ...base, type: z.literal("recent_updates"), config: recentUpdatesConfig }),
  z.object({ ...base, type: z.literal("rich_text"), config: richTextConfig }),
])
export type PortalHomeWidget = z.infer<typeof widgetSchema>
export type WidgetType = PortalHomeWidget["type"]

/** Strict: used on writes. Rejects duplicate ids and over-long layouts. */
export const layoutSchema = z
  .array(widgetSchema)
  .max(MAX_WIDGETS)
  .refine((widgets) => new Set(widgets.map((w) => w.id)).size === widgets.length, "Widget ids must be unique")

export const WIDGET_DEFINITIONS = {
  announcement: announcementDefinition,
  key_links: keyLinksDefinition,
  roadmap_spotlight: roadmapSpotlightDefinition,
  feedback_cta: feedbackCtaDefinition,
  recent_updates: recentUpdatesDefinition,
  rich_text: richTextDefinition,
} as const

export const WIDGET_TYPES = Object.keys(WIDGET_DEFINITIONS) as WidgetType[]

export function newWidgetId(): string {
  return `w_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`
}

/** Builds a fresh widget of `type` with its default config, appended at `order`. */
export function createWidget(type: WidgetType, order: number): PortalHomeWidget {
  const definition = WIDGET_DEFINITIONS[type]
  return {
    id: newWidgetId(),
    type,
    size: definition.defaultSize,
    order,
    visibility: "everyone",
    config: definition.defaultConfig(),
  } as PortalHomeWidget
}

/** Stable display order; ties (hand-edited rows) fall back to id. */
export function sortWidgets(widgets: readonly PortalHomeWidget[]): PortalHomeWidget[] {
  return [...widgets].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
}

/** Rewrites `order` to 0..n-1 in current array order. */
export function normalizeOrder(widgets: readonly PortalHomeWidget[]): PortalHomeWidget[] {
  return widgets.map((widget, index) => ({ ...widget, order: index }))
}

/**
 * Lenient: used on reads of stored JSON. An invalid or unknown-type widget is
 * dropped rather than failing the whole page, so an older row or a hand-edited
 * value can never take the portal down. Returns [] for anything that is not an
 * array. Duplicate ids keep the first.
 */
export function parseStoredWidgets(value: unknown): PortalHomeWidget[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const widgets: PortalHomeWidget[] = []
  for (const candidate of value.slice(0, MAX_WIDGETS)) {
    const parsed = widgetSchema.safeParse(candidate)
    if (!parsed.success || seen.has(parsed.data.id)) continue
    seen.add(parsed.data.id)
    widgets.push(parsed.data)
  }
  return sortWidgets(widgets)
}

/** JSON with object keys sorted, so key order (Zod output vs hand-built widgets) never reads as a change. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`
  }
  return JSON.stringify(value)
}

/** True when the draft differs from what customers currently see. */
export function hasUnpublishedChanges(draft: readonly PortalHomeWidget[], published: readonly PortalHomeWidget[] | null): boolean {
  if (published === null) return draft.length > 0
  return canonicalJson(normalizeOrder(draft)) !== canonicalJson(normalizeOrder(published))
}
