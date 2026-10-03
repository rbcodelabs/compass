import { z } from "zod"
import { requiredText, text } from "../fields"

export const feedbackCtaConfig = z.object({
  title: requiredText(80),
  description: text(160).default(""),
  buttonLabel: requiredText(40),
  showTopIdeas: z.boolean().default(true),
})
export type FeedbackCtaConfig = z.infer<typeof feedbackCtaConfig>

export const feedbackCtaDefinition = {
  type: "feedback_cta" as const,
  label: "Feedback",
  description: "Submit button and top-voted ideas",
  defaultSize: "S" as const,
  configSchema: feedbackCtaConfig,
  defaultConfig: (): FeedbackCtaConfig => ({
    title: "Got an idea?",
    description: "Tell us what would make your day easier.",
    buttonLabel: "Submit feedback",
    showTopIdeas: true,
  }),
}
