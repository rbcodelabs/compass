/**
 * Read-only vocabulary data for agents (MCP workspace summary tools).
 *
 * Agents are not workspace admins, so there is no write tool. Tool names, tool
 * descriptions and every other piece of MCP output stay canonical in every
 * preset; this only tells an agent how the humans in the workspace talk, so it
 * can use their words when it writes to them.
 *
 * The one-line note interpolates user-chosen label text. That text has already
 * passed validate.ts (letters, digits, spaces and a few punctuation marks, up to
 * 32 characters, no quotes or angle brackets) and is re-checked on read, which is
 * what keeps this line from becoming a prompt-injection channel.
 */

import { CLASSIC_THINKING_MODEL, resolveThinkingModel, type ThinkingModelSource } from "./resolve"
import { THINKING_MODEL_ENTITIES, type ThinkingModelEntity } from "./presets"

export type McpThinkingModel = {
  key: string
  name: string
  labels: Record<ThinkingModelEntity, { singular: string; plural: string }>
}

export function thinkingModelForMcp(source: ThinkingModelSource): {
  structured: McpThinkingModel
  line: string | null
} {
  const resolved = resolveThinkingModel(source)
  const labels = Object.fromEntries(
    THINKING_MODEL_ENTITIES.map((e) => [
      e,
      { singular: resolved.labels[e].singular, plural: resolved.labels[e].plural },
    ]),
  ) as McpThinkingModel["labels"]

  const renamed = THINKING_MODEL_ENTITIES.filter(
    (e) => resolved.labels[e].plural !== CLASSIC_THINKING_MODEL.labels[e].plural,
  )
  const line = renamed.length
    ? `This workspace calls ${renamed
        .map((e) => `${CLASSIC_THINKING_MODEL.labels[e].plural} "${resolved.labels[e].plural}"`)
        .join(" and ")}; API and tool names are unchanged.`
    : null

  return { structured: { key: resolved.key, name: resolved.name, labels }, line }
}
