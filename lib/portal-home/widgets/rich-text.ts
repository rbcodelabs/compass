import { z } from "zod"
import { text } from "../fields"

export const richTextConfig = z.object({
  title: text(80).default(""),
  /** Plain text; blank lines separate paragraphs. Never rendered as HTML. */
  body: text(2000).default(""),
})
export type RichTextConfig = z.infer<typeof richTextConfig>

export const richTextDefinition = {
  type: "rich_text" as const,
  label: "Text block",
  description: "Free-form text block",
  defaultSize: "M" as const,
  configSchema: richTextConfig,
  defaultConfig: (): RichTextConfig => ({ title: "", body: "" }),
}
