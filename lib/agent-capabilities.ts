/**
 * The "available / unavailable capabilities" sentence pair in the agent's system
 * prompt.
 *
 * Lives here rather than inline in app/api/agent/turn/route.ts for one reason:
 * it is the only part of that prompt that now varies per user, so it is the only
 * part worth asserting in a test — and the route module cannot be imported in one
 * without dragging in Prisma, the sandbox client, and NextAuth.
 */

/**
 * Capabilities the sandbox genuinely lacks, absent any connector.
 *
 * Stated to the model because an agent that believes it can shell out or browse
 * wastes turns discovering otherwise. Kept as data rather than prose so a
 * connector can *remove* an entry: once a user connects, say, a GitHub MCP
 * server, continuing to assert GitHub is unavailable would be a lie the model
 * acts on — it would refuse work it can now do.
 */
export const BASE_UNAVAILABLE_CAPABILITIES: readonly string[] = [
  "local files",
  "shell",
  "web",
  "GitHub",
  "Jira",
  "Vercel",
  "Obsidian",
  "hooks",
  "commands",
  "subagents",
]

export interface CapabilityConnector {
  slug: string
  displayName: string
}

/**
 * Derived from what this user actually connected rather than hardcoded.
 *
 * Note this describes only *host* capability. It deliberately does not enumerate
 * the connector's tools — the MCP client discovers those itself, and listing them
 * here would mean Compass maintaining a second, staler copy of a remote catalog.
 */
export function describeCapabilities(connectors: readonly CapabilityConnector[]): string {
  const connected = new Set(
    connectors.flatMap(definition => [definition.slug.toLowerCase(), definition.displayName.toLowerCase()]),
  )
  const unavailable = BASE_UNAVAILABLE_CAPABILITIES.filter(name => !connected.has(name.toLowerCase()))
  const available = ["compass.product_state", ...connectors.map(definition => definition.slug)]
  const availableSentence = `Available host ${available.length === 1 ? "capability" : "capabilities"}: ${available.join(", ")}.`
  const connectorSentence = connectors.length
    ? ` The user has connected ${formatList(connectors.map(definition => definition.displayName))}; ` +
      `those tools are reachable through Compass and act as the user's own account there.`
    : ""
  return `${availableSentence}${connectorSentence} Unavailable capabilities include ${formatList(unavailable)}.`
}

export function formatList(items: readonly string[]): string {
  if (items.length === 0) return "none"
  if (items.length === 1) return items[0]
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`
}
