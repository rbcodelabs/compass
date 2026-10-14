import { ArrowUpRight, FileText, Plus, Trash2 } from "lucide-react"
import type { KeyLink, KeyLinksConfig } from "@/lib/portal-home/widgets/key-links"
import type { ResolvedWidgetData } from "@/lib/portal-home/data"
import { PortalLink, WidgetCard } from "../widget-frame"
import { SelectField, TextField } from "../form-controls"
import type { ConfigFormProps, RendererProps } from "../types"
import { Button } from "@/components/ui/button"

type LinksData = Extract<ResolvedWidgetData, { type: "key_links" }>

export function KeyLinksRenderer({ config, data }: RendererProps<KeyLinksConfig, LinksData>) {
  return (
    <WidgetCard title={config.title}>
      <ul className="flex flex-col divide-y divide-border-default">
        {data.links.map((link, index) => (
          <li key={`${link.href}-${index}`}>
            <PortalLink href={link.href} external={link.external} className="flex items-center gap-3 py-2.5 text-sm font-medium text-text-primary hover:text-primary">
              {link.kind === "doc" ? <FileText className="size-4 shrink-0 text-text-subtle" aria-hidden /> : <ArrowUpRight className="size-4 shrink-0 text-text-subtle" aria-hidden />}
              <span className="min-w-0 flex-1 truncate">{link.label}</span>
            </PortalLink>
          </li>
        ))}
      </ul>
    </WidgetCard>
  )
}

export function KeyLinksForm({ config, onChange, options }: ConfigFormProps<KeyLinksConfig>) {
  const setLink = (index: number, link: KeyLink) => onChange({ ...config, links: config.links.map((l, i) => (i === index ? link : l)) })
  const removeLink = (index: number) => onChange({ ...config, links: config.links.filter((_, i) => i !== index) })
  const docs = options?.docs ?? []
  return (
    <div className="flex flex-col gap-3">
      <TextField id="kl-title" label="Title" value={config.title} max={80} required onChange={(title) => onChange({ ...config, title })} />
      <ul className="flex flex-col gap-3">
        {config.links.map((link, index) => (
          <li key={index} className="flex flex-col gap-2 rounded-lg border border-border-default p-3">
            {link.kind === "url" ? (
              <>
                <TextField id={`kl-label-${index}`} label="Label" value={link.label} max={80} onChange={(label) => setLink(index, { ...link, label })} />
                <TextField id={`kl-url-${index}`} label="URL" value={link.url} max={2000} placeholder="https://…" onChange={(url) => setLink(index, { ...link, url })} />
              </>
            ) : (
              <>
                <SelectField
                  id={`kl-doc-${index}`}
                  label="Compass Doc"
                  value={link.docId}
                  onChange={(docId) => setLink(index, { ...link, docId })}
                  options={[
                    ...(docs.some((doc) => doc.id === link.docId) ? [] : [{ value: link.docId, label: "Choose a doc…" }]),
                    ...docs.map((doc) => ({ value: doc.id, label: doc.title })),
                  ]}
                />
                <TextField id={`kl-doclabel-${index}`} label="Label (optional)" value={link.label} max={80} onChange={(label) => setLink(index, { ...link, label })} />
                <p className="text-xs leading-5 text-text-subtle">Docs are not public yet: only workspace members see Doc links. Customers will not.</p>
              </>
            )}
            <Button type="button" variant="ghost" size="sm" className="self-start" onClick={() => removeLink(index)}>
              <Trash2 /> Remove link
            </Button>
          </li>
        ))}
      </ul>
      {config.links.length < 10 ? (
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => onChange({ ...config, links: [...config.links, { kind: "url", label: "", url: "https://" }] })}>
            <Plus /> Add URL
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={docs.length === 0}
            onClick={() => onChange({ ...config, links: [...config.links, { kind: "doc", docId: docs[0].id, label: "" }] })}
          >
            <Plus /> Add Compass Doc
          </Button>
        </div>
      ) : null}
    </div>
  )
}
