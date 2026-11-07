import { ArrowDown, ArrowUp, FileText, X } from "lucide-react"
import { DOCS_WIDGET_MAX_ITEMS, type DocsConfig } from "@/lib/portal-home/widgets/docs"
import type { DocCardItem, ResolvedWidgetData } from "@/lib/portal-home/data"
import { formatDocDate } from "@/lib/portal-docs/format"
import { StatusBadge } from "@/components/patterns/status-badge"
import { Checkbox } from "@/components/ui/checkbox"
import { EmptyState } from "@/components/patterns/empty-state"
import { MoreLink, PortalLink, WidgetCard } from "../widget-frame"
import { SelectField, TextField } from "../form-controls"
import type { ConfigFormProps, RendererProps } from "../types"

type DocsData = Extract<ResolvedWidgetData, { type: "docs" }>

/** `/portal/o/w/docs/<id>` -> `/portal/o/w/docs`. The resolver builds every href from one base, so this is exact. */
function docsIndexOf(docs: DocCardItem[]): string | null {
  const first = docs[0]?.href
  return first ? first.replace(/\/[^/]+$/, "") : null
}

function DocCard({ doc }: { doc: DocCardItem }) {
  return (
    <li className="min-w-0">
      <PortalLink
        href={doc.href}
        className="group flex h-full items-start gap-3 rounded-lg border border-transparent p-2.5 transition-colors hover:border-border-default hover:bg-surface-inset focus-visible:border-border-focus focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-surface-inset text-text-subtle group-hover:bg-surface-panel" aria-hidden>
          <FileText className="size-4" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-sm font-semibold text-text-primary group-hover:text-primary">{doc.title || "Untitled"}</span>
          {doc.excerpt ? <span className="line-clamp-2 text-xs leading-5 text-text-secondary">{doc.excerpt}</span> : null}
          <span className="text-xs text-text-subtle">Updated {formatDocDate(doc.updatedAt)}</span>
        </span>
      </PortalLink>
    </li>
  )
}

/**
 * Published docs as a list that becomes a two-column card grid when the widget itself is wide (size L, or a
 * single-column template). It reads the WIDGET's width (container query), not the viewport, so it adapts in
 * every template without knowing which one it sits in.
 */
export function DocsRenderer({ config, data }: RendererProps<DocsConfig, DocsData>) {
  const indexHref = docsIndexOf(data.docs)
  return (
    <WidgetCard title={config.heading}>
      <div className="@container">
        {data.docs.length === 0 ? (
          <EmptyState compact icon={<FileText className="size-4" aria-hidden />} title="No docs published yet" description="Guides and references will appear here once they are published." />
        ) : (
          <ul className="grid grid-cols-1 gap-1 @xl:grid-cols-2 @xl:gap-2" data-testid="docs-widget-list">
            {data.docs.map((doc) => (
              <DocCard key={doc.id} doc={doc} />
            ))}
          </ul>
        )}
      </div>
      {indexHref ? <MoreLink href={indexHref}>Browse all docs</MoreLink> : null}
    </WidgetCard>
  )
}

export function DocsForm({ config, onChange, options }: ConfigFormProps<DocsConfig>) {
  const docs = options?.docs ?? []
  const byId = new Map(docs.map((doc) => [doc.id, doc]))
  const atLimit = config.docIds.length >= DOCS_WIDGET_MAX_ITEMS
  const toggle = (id: string, on: boolean) =>
    onChange({ ...config, docIds: on ? [...config.docIds, id] : config.docIds.filter((x) => x !== id) })
  const move = (index: number, delta: -1 | 1) => {
    const next = [...config.docIds]
    const target = index + delta
    if (target < 0 || target >= next.length) return
    ;[next[index], next[target]] = [next[target], next[index]]
    onChange({ ...config, docIds: next })
  }
  return (
    <div className="flex flex-col gap-3">
      <TextField id="docs-heading" label="Heading" value={config.heading} max={80} required onChange={(heading) => onChange({ ...config, heading })} />
      <SelectField
        id="docs-max"
        label="Maximum docs shown"
        value={String(config.maxItems)}
        onChange={(maxItems) => onChange({ ...config, maxItems: Number(maxItems) })}
        options={Array.from({ length: DOCS_WIDGET_MAX_ITEMS }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }))}
      />
      <SelectField
        id="docs-mode"
        label="Which docs"
        value={config.mode}
        onChange={(mode) => onChange({ ...config, mode: mode as DocsConfig["mode"] })}
        options={[
          { value: "all", label: "All published docs (newest first)" },
          { value: "selected", label: "Selected docs" },
        ]}
      />
      {config.mode === "selected" ? (
        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium">Choose docs</span>
          {options === null ? <p className="text-xs text-text-subtle">Loading docs…</p> : null}
          {options && docs.length === 0 ? <p className="text-xs leading-5 text-text-subtle">No publishable docs yet. Create a doc, then publish it from the doc header.</p> : null}
          {config.docIds.length > 0 ? (
            <ol className="flex flex-col gap-1" aria-label="Selected docs, in display order">
              {config.docIds.map((id, index) => {
                const doc = byId.get(id)
                return (
                  <li key={id} className="flex items-center gap-1.5 rounded-md border border-border-default bg-surface-inset px-2 py-1 text-xs">
                    <span className="min-w-0 flex-1 truncate">{doc ? doc.title || "Untitled" : "Unavailable doc"}</span>
                    {doc && !doc.isPublished ? <StatusBadge status="neutral">Draft</StatusBadge> : null}
                    <button type="button" aria-label={`Move ${doc?.title ?? "doc"} up`} disabled={index === 0} className="rounded p-0.5 hover:bg-muted disabled:opacity-40" onClick={() => move(index, -1)}>
                      <ArrowUp className="size-3" />
                    </button>
                    <button type="button" aria-label={`Move ${doc?.title ?? "doc"} down`} disabled={index === config.docIds.length - 1} className="rounded p-0.5 hover:bg-muted disabled:opacity-40" onClick={() => move(index, 1)}>
                      <ArrowDown className="size-3" />
                    </button>
                    <button type="button" aria-label={`Remove ${doc?.title ?? "doc"}`} className="rounded p-0.5 hover:bg-muted" onClick={() => toggle(id, false)}>
                      <X className="size-3" />
                    </button>
                  </li>
                )
              })}
            </ol>
          ) : null}
          {docs.length > 0 ? (
            <ul className="max-h-56 overflow-y-auto rounded-md border border-border-default" aria-label="Publishable docs">
              {docs.map((doc) => {
                const checked = config.docIds.includes(doc.id)
                const id = `docs-pick-${doc.id}`
                return (
                  <li key={doc.id} className="border-b border-border-default last:border-b-0">
                    <label htmlFor={id} className="flex items-center gap-2 px-2.5 py-1.5 text-sm">
                      <Checkbox id={id} checked={checked} disabled={!checked && atLimit} onCheckedChange={(next) => toggle(doc.id, next === true)} />
                      <span className="min-w-0 flex-1 truncate">{doc.title || "Untitled"}</span>
                      <StatusBadge status={doc.isPublished ? "success" : "neutral"}>{doc.isPublished ? "Published" : "Draft"}</StatusBadge>
                    </label>
                  </li>
                )
              })}
            </ul>
          ) : null}
          <p className="text-xs leading-5 text-text-subtle">
            Drafts can be picked ahead of time but stay hidden from customers until you publish them from the doc header. Up to {DOCS_WIDGET_MAX_ITEMS} docs.
          </p>
        </div>
      ) : (
        <p className="text-xs leading-5 text-text-subtle">Shows docs you have published to the portal. Unpublished docs are never shown.</p>
      )}
    </div>
  )
}
