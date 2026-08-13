/**
 * Small dependency-free "12 minutes ago" formatter. Shared by the doc version
 * MCP handlers (lib/doc-version-tool-handlers.ts) and the doc version history
 * UI panel (components/docs/doc-version-history-panel.tsx) so both render
 * timestamps the same way.
 */
export function relativeTime(date: Date): string {
  const diffMs = Date.now() - date.getTime()
  const diffSec = Math.round(diffMs / 1000)
  if (diffSec < 60) return "just now"
  const diffMin = Math.round(diffSec / 60)
  if (diffMin < 60) return `${diffMin} minute${diffMin === 1 ? "" : "s"} ago`
  const diffHour = Math.round(diffMin / 60)
  if (diffHour < 24) return `${diffHour} hour${diffHour === 1 ? "" : "s"} ago`
  const diffDay = Math.round(diffHour / 24)
  return `${diffDay} day${diffDay === 1 ? "" : "s"} ago`
}
