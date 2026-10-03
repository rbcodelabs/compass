import { z } from "zod"
import { cta, requiredText, text } from "../fields"

export const announcementConfig = z.object({
  eyebrow: text(60).default(""),
  headline: requiredText(140),
  body: text(600).default(""),
  primaryCta: cta.nullable().default(null),
  secondaryCta: cta.nullable().default(null),
})
export type AnnouncementConfig = z.infer<typeof announcementConfig>

export const announcementDefinition = {
  type: "announcement" as const,
  label: "Announcement",
  description: "Hero message with up to two calls to action",
  defaultSize: "L" as const,
  configSchema: announcementConfig,
  defaultConfig: (): AnnouncementConfig => ({
    eyebrow: "What's new",
    headline: "Share your latest news",
    body: "",
    primaryCta: null,
    secondaryCta: null,
  }),
}
