import { FileText } from "lucide-react"
import { DOCS_WIDGET_MAX_ITEMS, type DocsConfig } from "@/lib/portal-home/widgets/docs"
import type { ResolvedWidgetData } from "@/lib/portal-home/data"
import { PortalLink, WidgetCard } from "../widget-frame"
import { SelectField, TextField } from "../form-controls"
import type { ConfigFormProps, RendererProps } from "../types"

type DocsData = Extract<ResolvedWidgetData, { type: "docs" }>

/** Phase 1 stub: a plain list of published docs. Phase 2 replaces the presentation. */
export function DocsRenderer({ config, data }: RendererProps<DocsConfig, DocsData>) {
  return (
    <WidgetCard title={config.heading}>
      <ul className="flex flex-col divide-y divide-border-default">
        {data.docs.map((doc) => (
          <li key={doc.id}>
            <PortalLink href={doc.href} className="flex items-center gap-3 py-2.5 text-sm font-medium text-text-primary hover:text-primary">
              <FileText className="size-4 shrink-0 text-text-subtle" aria-hidden />
              <span className="min-w-0 flex-1 truncate">{doc.title}</span>
            </PortalLink>
          </li>
        ))}
      </ul>
    </WidgetCard>
  )
}

/** Phase 1 stub: heading, count and mode. Picking specific docs arrives with the Phase 2 UI. */
export function DocsForm({ config, onChange }: ConfigFormProps<DocsConfig>) {
  return (
    <div className="flex flex-col gap-3">
      <TextField id="docs-heading" label="Heading" value={config.heading} max={80} required onChange={(heading) => onChange({ ...config, heading })} />
      <SelectField
        id="docs-max"
        label="Number of docs"
        value={String(config.maxItems)}
        onChange={(maxItems) => onChange({ ...config, maxItems: Number(maxItems) })}
        options={Array.from({ length: DOCS_WIDGET_MAX_ITEMS }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }))}
      />
      <p className="text-xs leading-5 text-text-subtle">Shows docs you have published to the portal. Unpublished docs are never shown.</p>
    </div>
  )
}
