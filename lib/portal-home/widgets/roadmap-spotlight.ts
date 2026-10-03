import { z } from "zod"
import { requiredText, uuidLike } from "../fields"

export const SPOTLIGHT_MAX_ITEMS = 6

export const roadmapSpotlightConfig = z.object({
  title: requiredText(80),
  /** Pinned roadmap item ids, in display order. Empty means "latest Now items". */
  itemIds: z.array(uuidLike).max(SPOTLIGHT_MAX_ITEMS).default([]),
  show: z.enum(["status", "titles"]).default("status"),
})
export type RoadmapSpotlightConfig = z.infer<typeof roadmapSpotlightConfig>

export const roadmapSpotlightDefinition = {
  type: "roadmap_spotlight" as const,
  label: "Roadmap spotlight",
  description: "Pinned public roadmap items with their status",
  defaultSize: "M" as const,
  configSchema: roadmapSpotlightConfig,
  defaultConfig: (): RoadmapSpotlightConfig => ({ title: "Roadmap spotlight", itemIds: [], show: "status" }),
}
