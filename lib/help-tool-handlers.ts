/**
 * Handler functions for the Help MCP tools (search_help / get_help).
 *
 * Unlike every other MCP tool, these are NOT workspace-scoped: they search
 * Compass's own static product/usage documentation (docs/content/*.md, the
 * same corpus rendered at /help/[slug]) so any agent -- including an
 * in-app assistant -- can answer "how do I do X in Compass" without a
 * locally-installed skill. See lib/mcp-tool-gates.ts for the (no-op)
 * authorization policy this implies.
 */

import { searchHelp as searchHelpDocs, getHelpTopic, getDocRaw } from "@/lib/docs"

export async function searchHelp({ query, limit }: { query: string; limit?: number }) {
  const results = searchHelpDocs(query, limit ?? 5)

  if (!results.length) {
    return {
      content: [{ type: "text" as const, text: `No help docs found matching "${query}".` }],
    }
  }

  const lines = [`**${results.length} help doc match${results.length === 1 ? "" : "es"} for "${query}"**\n`]
  for (const r of results) {
    const anchor = r.anchor ? `#${r.anchor}` : ""
    lines.push(
      `• **${r.title}**${r.heading ? ` — ${r.heading}` : ""}\n` +
        `  Path: /help/${r.slug}${anchor}\n` +
        `  ${r.excerpt}`
    )
  }

  return { content: [{ type: "text" as const, text: lines.join("\n\n") }] }
}

export async function getHelp({ topic }: { topic: string }) {
  const meta = getHelpTopic(topic)
  const doc = meta ? getDocRaw(meta.slug) : null

  if (!doc) {
    return {
      content: [{ type: "text" as const, text: `No help doc found for topic "${topic}".` }],
    }
  }

  const lines = [
    `# ${doc.title}`,
    `Path: /help/${doc.slug}`,
    `Section: ${doc.section}`,
    "",
    doc.content,
  ]

  return { content: [{ type: "text" as const, text: lines.join("\n") }] }
}
