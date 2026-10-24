/**
 * The icons on an embed card's compact row: one per record kind (lucide) and one status glyph per StatusGlyphName (drawn here so the shapes
 * stay exactly the vocabulary in lib/spec-docs/embed-visual.ts). Decorative: the caller supplies the accessible name.
 */
import { ChartColumn, CircleHelp, FileText, FlaskConical, Flag, Gauge, Layers, Lightbulb, Map as MapIcon, SquareCheck, Target, type LucideIcon } from "lucide-react"
import type { DocEmbedKind } from "@/lib/doc-embeds"
import type { StatusGlyphName, StatusTone } from "@/lib/spec-docs/embed-visual"

export const KIND_ICON: Record<DocEmbedKind, LucideIcon> = {
  opportunity: Target,
  solution: Lightbulb,
  assumption: CircleHelp,
  experiment: FlaskConical,
  task: SquareCheck,
  objective: Flag,
  keyResult: Gauge,
  metric: ChartColumn,
  roadmapItem: MapIcon,
  doc: FileText,
  artifact: Layers,
}

export const TONE_CLASS: Record<StatusTone, string> = {
  neutral: "text-text-subtle",
  progress: "text-primary",
  done: "text-status-success",
  warn: "text-status-warning",
  danger: "text-status-danger",
}

const RING = <circle cx="12" cy="12" r="8" />
const CHECK = "m8.5 12 2.5 2.5 4.5-5"
const CROSS = "m9.5 9.5 5 5M14.5 9.5l-5 5"

const GLYPH_SHAPE: Record<StatusGlyphName, React.ReactNode> = {
  notStarted: <circle cx="12" cy="12" r="8" strokeDasharray="3 3" />,
  ready: RING,
  progress: <>{RING}<path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" /></>,
  review: <>{RING}<path d="M12 12V4a8 8 0 1 1-8 8z" fill="currentColor" /></>,
  validated: <>{RING}<path d={CHECK} /></>,
  done: <><circle cx="12" cy="12" r="8" fill="currentColor" /><path d={CHECK} className="stroke-surface-card" /></>,
  stopped: <>{RING}<path d={CROSS} /></>,
  disproved: <>{RING}<path d={CROSS} /></>,
  blocked: <>{RING}<path d="M6.3 6.3l11.4 11.4" /></>,
  archived: <path d="M3 4h18v4H3zM5 8v12h14V8M10 12h4" />,
  active: <>{RING}<circle cx="12" cy="12" r="3" fill="currentColor" /></>,
  onTrack: <>{RING}<path d="M8.5 15.5l7-7M10 8.5h5.5V14" /></>,
  atRisk: <><path d="M12 3 22 20H2z" /><path d="M12 10v4M12 17h.01" /></>,
  offTrack: <>{RING}<path d="M12 8v5M12 16h.01" /></>,
  stale: <>{RING}<path d="M12 7.5V12l3 2" /></>,
}

export function StatusGlyphIcon({ glyph, className }: { glyph: StatusGlyphName; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
      {GLYPH_SHAPE[glyph]}
    </svg>
  )
}
