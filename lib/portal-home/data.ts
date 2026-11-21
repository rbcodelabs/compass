/**
 * Resolved (customer-safe) data shapes, one per widget type. Client-safe types
 * only. Everything here is what a resolver chose to return; a resolver never
 * returns a whole database row, so a column added to a model later cannot leak
 * through a widget by accident.
 */

export interface PortalHomeLink {
  label: string
  href: string
  external: boolean
  kind: "url" | "doc"
  /** Set for doc links: lets the customer redaction keep only the doc links that resolved. */
  docId?: string
}

/** A published Doc as a card. Mirrors PublicDocSummary plus the viewer's link to it. */
export interface DocCardItem {
  id: string
  title: string
  excerpt: string
  updatedAt: string
  publishedAt: string
  href: string
}

export interface SpotlightItem {
  id: string
  title: string
  /** Public status label ("Now", "Next", ...), derived from the horizon. */
  statusLabel: string
  statusHorizon: string
  /** Planned window, only when both dates are set. */
  window: { start: string; end: string } | null
}

export interface UpdateItem {
  id: string
  title: string
  /** ISO timestamp the item last changed. */
  date: string
}

export interface TopIdea {
  id: string
  title: string
  voteCount: number
}

/** Team-only: an active Artifact as a gallery card. */
export interface ArtifactCardItem {
  id: string
  title: string
  kind: string | null
  sourceType: string
  updatedAt: string
  href: string
  /** In-app thumbnail URL (signed-in readers only), or null when no screenshot was captured. */
  thumbnailSrc: string | null
}

/** Team-only: an objective with its key results' average progress (0-100). */
export interface OkrObjectiveItem {
  id: string
  title: string
  status: string
  progress: number
  keyResultCount: number
  /** The objective's own cycle (null for a cycle-less objective); shown per row when objectives are hand-picked. */
  cycleTitle: string | null
}

export type ResolvedWidgetData =
  | { type: "announcement" }
  | { type: "rich_text" }
  | { type: "key_links"; links: PortalHomeLink[] }
  | { type: "docs"; docs: DocCardItem[] }
  | { type: "artifact_gallery"; artifacts: ArtifactCardItem[]; galleryHref: string }
  | { type: "okr_summary"; cycleTitle: string | null; objectives: OkrObjectiveItem[]; okrsHref: string }
  | { type: "roadmap_spotlight"; items: SpotlightItem[]; auto: boolean; roadmapHref: string }
  | { type: "recent_updates"; items: UpdateItem[]; roadmapHref: string }
  | { type: "feedback_cta"; feedbackHref: string; topIdeas: TopIdea[] }

/**
 * `available: false` means the surface behind the widget is switched off for this
 * workspace (roadmap not public, feedback disabled) or has nothing to show. The
 * customer page omits such widgets; the admin editor shows why.
 */
export type WidgetResolution =
  | { available: true; data: ResolvedWidgetData }
  | { available: false; reason: string }

