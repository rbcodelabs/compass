import Link from "next/link"
import type { ReactNode } from "react"
import type { TrackedDecisionSourceSnapshot, TrackedSourceType } from "@/lib/tracked-decisions"

type TrackedDecisionPacket = {
  schemaVersion: "tracked-decision/v1" | "tracked-decision/v2"
  question?: string
  context: string
  entity: Omit<TrackedDecisionSourceSnapshot, "updatedAt"> & { updatedAt?: string }
  sources: TrackedDecisionSourceSnapshot[]
}

const SOURCE_TYPES = new Set<TrackedSourceType>(["WORKSPACE", "OPPORTUNITY", "SOLUTION", "ASSUMPTION", "ROADMAP_ITEM", "DOC", "EXPERIMENT", "FEEDBACK", "EVIDENCE"])
const PANEL_TYPES: Partial<Record<TrackedSourceType, string>> = {
  OPPORTUNITY: "opportunity",
  SOLUTION: "solution",
  ASSUMPTION: "assumption",
  ROADMAP_ITEM: "roadmapItem",
  EXPERIMENT: "experiment",
  FEEDBACK: "feedback",
}

function isSource(value: unknown, requireUpdatedAt: boolean): value is TrackedDecisionSourceSnapshot {
  if (!value || typeof value !== "object") return false
  const source = value as Record<string, unknown>
  return SOURCE_TYPES.has(source.type as TrackedSourceType)
    && typeof source.id === "string"
    && typeof source.title === "string"
    && (!requireUpdatedAt || typeof source.updatedAt === "string")
}

export function parseTrackedDecisionPacket(raw: string): TrackedDecisionPacket | null {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>
    if (value.schemaVersion !== "tracked-decision/v1" && value.schemaVersion !== "tracked-decision/v2") return null
    if (typeof value.context !== "string" || !isSource(value.entity, false)) return null
    if (value.schemaVersion === "tracked-decision/v2") {
      if (typeof (value.entity as { updatedAt?: unknown }).updatedAt !== "string" || !Array.isArray(value.sources) || !value.sources.every((source) => isSource(source, true))) return null
    }
    return {
      schemaVersion: value.schemaVersion,
      question: typeof value.question === "string" ? value.question : undefined,
      context: value.context,
      entity: value.entity,
      sources: value.schemaVersion === "tracked-decision/v2" ? value.sources as TrackedDecisionSourceSnapshot[] : [],
    }
  } catch { return null }
}

function typeLabel(type: TrackedSourceType) {
  return type === "ROADMAP_ITEM" ? "Roadmap item" : type.charAt(0) + type.slice(1).toLowerCase()
}

function capturedLabel(updatedAt?: string) {
  if (!updatedAt) return null
  const date = new Date(updatedAt)
  if (Number.isNaN(date.getTime())) return null
  return `Captured ${new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(date)}`
}

function destination(source: TrackedDecisionPacket["entity"], orgSlug: string, workspaceSlug: string) {
  const panelType = PANEL_TYPES[source.type]
  if (panelType) return `?detail=${encodeURIComponent(`${panelType}:${source.id}`)}`
  if (source.type === "DOC") return `/${orgSlug}/${workspaceSlug}/docs/${source.id}`
  if (source.type === "WORKSPACE") return `/${orgSlug}/${workspaceSlug}`
  return null
}

function SourceRow({ source, orgSlug, workspaceSlug, primary = false }: { source: TrackedDecisionPacket["entity"]; orgSlug: string; workspaceSlug: string; primary?: boolean }) {
  const href = destination(source, orgSlug, workspaceSlug)
  const content = <>
    <span className="min-w-0 flex-1">
      <span className="block whitespace-normal break-words [overflow-wrap:anywhere] font-medium text-foreground">{source.title}</span>
      {capturedLabel(source.updatedAt) && <span className="mt-0.5 block text-xs text-muted-foreground">{capturedLabel(source.updatedAt)}</span>}
    </span>
    <span className="flex shrink-0 flex-col items-start gap-1 sm:items-end">
      <span className="rounded-full border bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">{typeLabel(source.type)}</span>
      {!href && <span className="text-xs text-muted-foreground">Snapshot only</span>}
    </span>
  </>
  const className = "flex min-w-0 max-w-full flex-col items-start gap-2 rounded-md border bg-background px-3 py-2 text-left sm:flex-row sm:items-center sm:gap-3"
  return <li>{href
    ? <Link aria-label={`${primary ? "Primary: " : ""}${source.title} (${typeLabel(source.type)})`} className={`${className} transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring`} href={href}>{content}</Link>
    : <div className={className}>{content}</div>}
  </li>
}

export function DecisionSources({ orgSlug, workspaceSlug, entity, sources, supportingArtifacts }: { orgSlug: string; workspaceSlug: string; entity: TrackedDecisionPacket["entity"]; sources: TrackedDecisionSourceSnapshot[]; supportingArtifacts?: ReactNode }) {
  return <div className="space-y-4">
    <div className="space-y-2">
      <h2 className="text-sm font-medium">Linked to</h2>
      <ul><SourceRow source={entity} orgSlug={orgSlug} workspaceSlug={workspaceSlug} primary /></ul>
      {supportingArtifacts}
    </div>
    {sources.length > 0 && <div className="space-y-2">
      <h2 className="text-sm font-medium">Sources</h2>
      <ul className="space-y-2">{sources.map((source) => <SourceRow key={`${source.type}:${source.id}`} source={source} orgSlug={orgSlug} workspaceSlug={workspaceSlug} />)}</ul>
    </div>}
  </div>
}
