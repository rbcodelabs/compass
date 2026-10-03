import type { FeedbackCtaConfig } from "@/lib/portal-home/widgets/feedback-cta"
import type { ResolvedWidgetData } from "@/lib/portal-home/data"
import { PortalLink, WidgetCard } from "../widget-frame"
import { CheckboxField, TextAreaField, TextField } from "../form-controls"
import type { ConfigFormProps, RendererProps } from "../types"

type FeedbackData = Extract<ResolvedWidgetData, { type: "feedback_cta" }>

export function FeedbackCtaRenderer({ config, data }: RendererProps<FeedbackCtaConfig, FeedbackData>) {
  return (
    <WidgetCard title={config.title}>
      {config.description ? <p className="text-sm leading-6 text-text-secondary">{config.description}</p> : null}
      <PortalLink href={data.feedbackHref} className="inline-flex h-9 w-fit items-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary-hover">
        {config.buttonLabel}
      </PortalLink>
      {data.topIdeas.length > 0 ? (
        <ol className="flex flex-col gap-1.5 border-t border-border-default pt-3 text-sm">
          {data.topIdeas.map((idea) => (
            <li key={idea.id} className="flex items-baseline gap-2">
              <span className="w-10 shrink-0 text-xs font-semibold text-text-subtle">▲ {idea.voteCount}</span>
              <span className="min-w-0 truncate">{idea.title}</span>
            </li>
          ))}
        </ol>
      ) : null}
    </WidgetCard>
  )
}

export function FeedbackCtaForm({ config, onChange }: ConfigFormProps<FeedbackCtaConfig>) {
  return (
    <div className="flex flex-col gap-3">
      <TextField id="fb-title" label="Title" value={config.title} max={80} required onChange={(title) => onChange({ ...config, title })} />
      <TextAreaField id="fb-desc" label="Description" value={config.description} max={160} rows={2} onChange={(description) => onChange({ ...config, description })} />
      <TextField id="fb-button" label="Button label" value={config.buttonLabel} max={40} required onChange={(buttonLabel) => onChange({ ...config, buttonLabel })} />
      <CheckboxField id="fb-top" label="Show top-voted ideas" checked={config.showTopIdeas} onChange={(showTopIdeas) => onChange({ ...config, showTopIdeas })} />
    </div>
  )
}
