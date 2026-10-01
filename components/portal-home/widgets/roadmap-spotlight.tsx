import { Plus, X } from "lucide-react"
import type { RoadmapSpotlightConfig } from "@/lib/portal-home/widgets/roadmap-spotlight"
import { SPOTLIGHT_MAX_ITEMS } from "@/lib/portal-home/widgets/roadmap-spotlight"
import type { ResolvedWidgetData } from "@/lib/portal-home/data"
import { StatusBadge } from "@/components/patterns/status-badge"
import { MoreLink, WidgetCard, formatShortDate } from "../widget-frame"
import { SelectField, TextField } from "../form-controls"
import type { ConfigFormProps, RendererProps } from "../types"

type SpotlightData = Extract<ResolvedWidgetData, { type: "roadmap_spotlight" }>

const STATUS_TONE: Record<string, "success" | "info" | "neutral" | "warning"> = {
  NOW: "success",
  NEXT: "info",
  LATER: "neutral",
  LAUNCHING: "warning",
  SHIPPED: "neutral",
}

export function RoadmapSpotlightRenderer({ config, data }: RendererProps<RoadmapSpotlightConfig, SpotlightData>) {
  return (
    <WidgetCard title={config.title}>
      <ul className="flex flex-col gap-3">
        {data.items.map((item) => (
          <li key={item.id} className="flex flex-col gap-1">
            <div className="flex items-start justify-between gap-2">
              <span className="text-sm font-medium text-text-primary">{item.title}</span>
              {config.show === "status" ? <StatusBadge status={STATUS_TONE[item.statusHorizon] ?? "neutral"}>{item.statusLabel}</StatusBadge> : null}
            </div>
            {config.show === "status" && item.window ? (
              <span className="text-xs text-text-subtle">
                {formatShortDate(item.window.start)} to {formatShortDate(item.window.end)}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      <MoreLink href={data.roadmapHref}>View full roadmap</MoreLink>
    </WidgetCard>
  )
}

export function RoadmapSpotlightForm({ config, onChange, options }: ConfigFormProps<RoadmapSpotlightConfig>) {
  const items = options?.roadmapItems ?? []
  const titleOf = (id: string) => items.find((item) => item.id === id)?.title ?? "Unavailable item"
  const unpinned = items.filter((item) => !config.itemIds.includes(item.id))
  return (
    <div className="flex flex-col gap-3">
      <TextField id="rs-title" label="Title" value={config.title} max={80} required onChange={(title) => onChange({ ...config, title })} />
      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">Pinned roadmap items</span>
        {config.itemIds.length === 0 ? <p className="text-xs leading-5 text-text-subtle">Nothing pinned: customers see the latest public items that are in progress.</p> : null}
        <ul className="flex flex-wrap gap-1.5">
          {config.itemIds.map((id) => (
            <li key={id} className="inline-flex items-center gap-1 rounded-full border border-border-default bg-surface-inset py-0.5 pr-1 pl-2.5 text-xs">
              {titleOf(id)}
              <button type="button" aria-label={`Unpin ${titleOf(id)}`} className="rounded-full p-0.5 hover:bg-muted" onClick={() => onChange({ ...config, itemIds: config.itemIds.filter((x) => x !== id) })}>
                <X className="size-3" />
              </button>
            </li>
          ))}
        </ul>
        {config.itemIds.length < SPOTLIGHT_MAX_ITEMS && unpinned.length > 0 ? (
          <div className="flex items-center gap-2">
            <select
              aria-label="Pin a roadmap item"
              className="h-8 min-w-0 flex-1 rounded-lg border border-input bg-transparent px-2 text-sm"
              value=""
              onChange={(event) => event.target.value && onChange({ ...config, itemIds: [...config.itemIds, event.target.value] })}
            >
              <option value="">Pin an item…</option>
              {unpinned.map((item) => (
                <option key={item.id} value={item.id}>{item.title}</option>
              ))}
            </select>
            <Plus className="size-4 text-text-subtle" aria-hidden />
          </div>
        ) : null}
      </div>
      <SelectField
        id="rs-show"
        label="Show"
        value={config.show}
        onChange={(show) => onChange({ ...config, show: show as RoadmapSpotlightConfig["show"] })}
        options={[{ value: "status", label: "Status and dates" }, { value: "titles", label: "Titles only" }]}
      />
      <p className="text-xs leading-5 text-text-subtle">Items you have not made public never appear to customers, even if pinned here.</p>
    </div>
  )
}
