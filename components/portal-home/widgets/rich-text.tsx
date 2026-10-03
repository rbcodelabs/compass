import type { RichTextConfig } from "@/lib/portal-home/widgets/rich-text"
import { PlainParagraphs, WidgetCard } from "../widget-frame"
import { TextAreaField, TextField } from "../form-controls"
import type { ConfigFormProps, RendererProps } from "../types"

export function RichTextRenderer({ config }: RendererProps<RichTextConfig>) {
  return (
    <WidgetCard title={config.title || undefined}>
      <PlainParagraphs text={config.body} className="text-text-secondary" />
    </WidgetCard>
  )
}

export function RichTextForm({ config, onChange }: ConfigFormProps<RichTextConfig>) {
  return (
    <div className="flex flex-col gap-3">
      <TextField id="rt-title" label="Title (optional)" value={config.title} max={80} onChange={(title) => onChange({ ...config, title })} />
      <TextAreaField id="rt-body" label="Text" value={config.body} max={2000} rows={8} description="Plain text. Leave a blank line between paragraphs." onChange={(body) => onChange({ ...config, body })} />
    </div>
  )
}
