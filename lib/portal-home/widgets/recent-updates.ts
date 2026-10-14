import { z } from "zod"
import { requiredText } from "../fields"

export const recentUpdatesConfig = z.object({
  title: requiredText(80),
  limit: z.number().int().min(1).max(10).default(4),
})
export type RecentUpdatesConfig = z.infer<typeof recentUpdatesConfig>

export const recentUpdatesDefinition = {
  type: "recent_updates" as const,
  label: "Recent updates",
  description: "Latest shipped public roadmap items",
  defaultSize: "S" as const,
  configSchema: recentUpdatesConfig,
  defaultConfig: (): RecentUpdatesConfig => ({ title: "Recently shipped", limit: 4 }),
}
