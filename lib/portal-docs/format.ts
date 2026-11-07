/** Client-safe date formatting for the public docs surfaces. UTC so server and client render the same string. */
export function formatDocDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })
}

/** The docs index path for a portal: `/portal/<org>/<workspace>/docs`. */
export function portalDocsPath(orgSlug: string, workspaceSlug: string): string {
  return `/portal/${orgSlug}/${workspaceSlug}/docs`
}

/**
 * Docs often open with an H1 that repeats the doc title; the public page already renders the title as its own
 * heading, so drop that first line (only when it equals the title, case-insensitively).
 */
export function stripLeadingTitle(body: string, title: string): string {
  const match = /^\s*#\s+(.+?)\s*#*\s*(?:\r?\n|$)/.exec(body)
  if (!match || match[1].trim().toLowerCase() !== title.trim().toLowerCase()) return body
  return body.slice(match[0].length).replace(/^\s+/, "")
}

/**
 * The docs hub's "Popular" quick searches, derived from real published doc titles (no analytics exist, and
 * none are faked): untitled/duplicate titles drop out, long titles are shortened on a word boundary, at most
 * `max` are returned in the order given (newest published first).
 */
export function popularSearchTerms(titles: readonly string[], max = 3): string[] {
  const seen = new Set<string>()
  const terms: string[] = []
  for (const raw of titles) {
    let title = raw.trim().replace(/\s+/g, " ")
    if (!title) continue
    if (title.length > 32) title = `${title.slice(0, 32).replace(/\s+\S*$/, "")}`.trim() || title.slice(0, 32)
    const key = title.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    terms.push(title)
    if (terms.length === max) break
  }
  return terms
}
