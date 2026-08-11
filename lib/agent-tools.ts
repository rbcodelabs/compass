/**
 * Presentation helpers for agent tool calls in the chat UI.
 */

/**
 * Turn a raw MCP tool name into a human-friendly label.
 *   mcp__compass__list_top_opportunities → "List top opportunities"
 *   get_workspace_summary                → "Get workspace summary"
 */
export function humanizeToolName(name: string): string {
  const bare = name.replace(/^mcp__[^_]+__/, "")
  const words = bare.split("_").filter(Boolean)
  if (words.length === 0) return name
  return words
    .map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ")
}
