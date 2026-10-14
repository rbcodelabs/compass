import type { AnnouncementConfig } from "@/lib/portal-home/widgets/announcement"
import { PlainParagraphs, PortalLink, WidgetCard } from "../widget-frame"
import { TextAreaField, TextField } from "../form-controls"
import type { ConfigFormProps, RendererProps } from "../types"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

const external = (url: string) => !url.startsWith("/")

export function AnnouncementRenderer({ config }: RendererProps<AnnouncementConfig>) {
  return (
    <WidgetCard tone="hero" className="gap-3 p-6 sm:p-8">
      {config.eyebrow ? <span className="text-xs font-semibold uppercase tracking-wide opacity-80">{config.eyebrow}</span> : null}
      <h2 className="text-2xl font-semibold leading-tight sm:text-3xl">{config.headline}</h2>
      {config.body ? <PlainParagraphs text={config.body} className="max-w-2xl opacity-90" /> : null}
      {config.primaryCta || config.secondaryCta ? (
        <div className="mt-1 flex flex-wrap gap-2">
          {config.primaryCta ? (
            <PortalLink href={config.primaryCta.url} external={external(config.primaryCta.url)} className="inline-flex h-9 items-center rounded-lg bg-primary-foreground px-4 text-sm font-medium text-primary hover:opacity-90">
              {config.primaryCta.label}
            </PortalLink>
          ) : null}
          {config.secondaryCta ? (
            <PortalLink href={config.secondaryCta.url} external={external(config.secondaryCta.url)} className="inline-flex h-9 items-center rounded-lg border border-primary-foreground/50 px-4 text-sm font-medium hover:bg-primary-foreground/10">
              {config.secondaryCta.label}
            </PortalLink>
          ) : null}
        </div>
      ) : null}
    </WidgetCard>
  )
}

function CtaEditor({ id, legend, value, onChange }: { id: string; legend: string; value: AnnouncementConfig["primaryCta"]; onChange: (value: AnnouncementConfig["primaryCta"]) => void }) {
  return (
    <fieldset className={cn("flex flex-col gap-2 rounded-lg border border-border-default p-3")}>
      <legend className="px-1 text-xs font-medium text-text-subtle">{legend}</legend>
      {value ? (
        <>
          <TextField id={`${id}-label`} label="Button label" value={value.label} max={40} onChange={(label) => onChange({ ...value, label })} />
          <TextField id={`${id}-url`} label="Link" value={value.url} max={2000} placeholder="https://… or /portal/…" description="http(s) URL or a path starting with /" onChange={(url) => onChange({ ...value, url })} />
          <Button type="button" variant="ghost" size="sm" className="self-start" onClick={() => onChange(null)}>Remove button</Button>
        </>
      ) : (
        <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => onChange({ label: "Learn more", url: "https://" })}>Add button</Button>
      )}
    </fieldset>
  )
}

export function AnnouncementForm({ config, onChange }: ConfigFormProps<AnnouncementConfig>) {
  return (
    <div className="flex flex-col gap-3">
      <TextField id="ann-eyebrow" label="Eyebrow" value={config.eyebrow} max={60} onChange={(eyebrow) => onChange({ ...config, eyebrow })} />
      <TextField id="ann-headline" label="Headline" value={config.headline} max={140} required onChange={(headline) => onChange({ ...config, headline })} />
      <TextAreaField id="ann-body" label="Message" value={config.body} max={600} onChange={(body) => onChange({ ...config, body })} />
      <CtaEditor id="ann-primary" legend="Primary button" value={config.primaryCta} onChange={(primaryCta) => onChange({ ...config, primaryCta })} />
      <CtaEditor id="ann-secondary" legend="Secondary button" value={config.secondaryCta} onChange={(secondaryCta) => onChange({ ...config, secondaryCta })} />
    </div>
  )
}
