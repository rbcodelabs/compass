import type { RecentUpdatesConfig } from "@/lib/portal-home/widgets/recent-updates"
import type { ResolvedWidgetData } from "@/lib/portal-home/data"
import { MoreLink, WidgetCard, formatShortDate } from "../widget-frame"
import { SelectField, TextField } from "../form-controls"
import type { ConfigFormProps, RendererProps } from "../types"

type UpdatesData = Extract<ResolvedWidgetData, { type: "recent_updates" }>

export function RecentUpdatesRenderer({ config, data }: RendererProps<RecentUpdatesConfig, UpdatesData>) {
  return (
    <WidgetCard title={config.title}>
      <ul className="flex flex-col gap-2.5">
        {data.items.map((item) => (
          <li key={item.id} className="flex items-baseline gap-3 text-sm">
            <time dateTime={item.date} className="w-12 shrink-0 text-xs text-text-subtle">{formatShortDate(item.date)}</time>
            <span className="min-w-0">{item.title}</span>
          </li>
        ))}
      </ul>
      <MoreLink href={data.roadmapHref}>See the roadmap</MoreLink>
    </WidgetCard>
  )
}

export function RecentUpdatesForm({ config, onChange }: ConfigFormProps<RecentUpdatesConfig>) {
  return (
    <div className="flex flex-col gap-3">
      <TextField id="ru-title" label="Title" value={config.title} max={80} required onChange={(title) => onChange({ ...config, title })} />
      <SelectField
        id="ru-limit"
        label="Number of updates"
        value={String(config.limit)}
        onChange={(limit) => onChange({ ...config, limit: Number(limit) })}
        options={[2, 3, 4, 5, 6, 8, 10].map((n) => ({ value: String(n), label: String(n) }))}
      />
      <p className="text-xs leading-5 text-text-subtle">Lists public roadmap items marked Shipped or Launched.</p>
    </div>
  )
}
