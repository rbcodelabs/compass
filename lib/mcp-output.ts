import { z } from "zod"

/**
 * Uniform structured-output envelope for every MCP tool.
 *
 * Historically Compass MCP tools returned only a human-readable text block
 * (`content[0].text`), so programmatic callers (cron gates, agents) had to
 * scrape prose. This envelope adds a machine-readable `structuredContent`
 * alongside the unchanged text, so callers can read `structuredContent.data`
 * (and `.ok`) instead of regex-matching sentences.
 *
 * Declared as the `outputSchema` on every registered tool. Per the MCP SDK
 * (@modelcontextprotocol/sdk validateToolOutput), any tool that declares an
 * outputSchema MUST return a `structuredContent` that validates against it on
 * every non-error return path, or the SDK throws at call time. Always build
 * tool results with `ok()` / `fail()` below so that invariant holds.
 *
 * Payload conventions for `data`:
 *   - list_* tools        → { items: [...], count }
 *   - get_* / single      → the entity object
 *   - create_/add_        → the created entity (at least { id, ...key fields })
 *   - update_/move_/link_ → the updated entity or { id, ...changed fields }
 *   - not-found / no-op    → null (via fail())
 */
export const TOOL_OUTPUT_SCHEMA = {
  ok: z.boolean().describe("Whether the tool call succeeded"),
  message: z
    .string()
    .describe("Human-readable summary — identical to the text content block"),
  data: z
    .unknown()
    .describe(
      "Structured result payload: an object for single entities, { items, count } for lists, or null",
    ),
}

export type ToolResult = {
  content: { type: "text"; text: string }[]
  structuredContent: { ok: boolean; message: string; data: unknown }
}

/**
 * Success result. Keeps the exact human-readable `text` and attaches a
 * structured `data` payload alongside it.
 */
export function ok(text: string, data: unknown = null): ToolResult {
  return {
    content: [{ type: "text", text }],
    structuredContent: { ok: true, message: text, data },
  }
}

/**
 * Non-success result (not-found, validation failure, no-op). Preserves the
 * exact `text` and — matching prior behavior — does NOT set `isError`, but
 * still supplies a valid `structuredContent` so SDK output validation passes.
 */
export function fail(text: string, data: unknown = null): ToolResult {
  return {
    content: [{ type: "text", text }],
    structuredContent: { ok: false, message: text, data },
  }
}

/** A tool result that carries an image the model can look at directly. */
export type ImageToolResult = {
  content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[]
  structuredContent: { ok: boolean; message: string; data: unknown }
}

/**
 * Success result with an inline image. The text block and `structuredContent`
 * are built exactly as `ok()` builds them, so the outputSchema invariant above
 * still holds; the image rides as an extra MCP image content block. Keep the
 * image bytes OUT of `data` — structuredContent is logged and echoed to callers
 * that cannot render it.
 */
export function okWithImage(text: string, image: { data: Buffer; mimeType: string }, data: unknown = null): ImageToolResult {
  return {
    content: [
      { type: "text", text },
      { type: "image", data: image.data.toString("base64"), mimeType: image.mimeType },
    ],
    structuredContent: { ok: true, message: text, data },
  }
}
