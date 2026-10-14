import { z } from "zod"
import { requiredText, safeLinkUrl, uuidLike } from "../fields"

export const keyLink = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("url"), label: requiredText(80), url: safeLinkUrl }),
  // Doc links reference a Compass Doc by id. Docs are not public in v1, so the
  // resolver only returns them to workspace members (see resolvers/key-links.ts).
  z.object({ kind: z.literal("doc"), docId: uuidLike, label: z.string().trim().max(80).default("") }),
])
export type KeyLink = z.infer<typeof keyLink>

export const keyLinksConfig = z.object({
  title: requiredText(80),
  links: z.array(keyLink).max(10).default([]),
})
export type KeyLinksConfig = z.infer<typeof keyLinksConfig>

export const keyLinksDefinition = {
  type: "key_links" as const,
  label: "Key links",
  description: "Curated documents and URLs",
  defaultSize: "M" as const,
  configSchema: keyLinksConfig,
  defaultConfig: (): KeyLinksConfig => ({ title: "Key links", links: [] }),
}
