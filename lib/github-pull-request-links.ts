/**
 * GitHub pull request links, client-safe (no server imports). The agent transcript turns a PR URL into a chip, and the chip opens
 * the detail sidebar addressed as ?detail=pullRequest:<owner>/<repo>/<number>.
 */

export type PullRequestRef = { owner: string; repo: string; number: number }

const PART = /^[A-Za-z0-9._-]+$/
const DIGITS = /^[0-9]+$/

function build(owner: string | undefined, repo: string | undefined, num: string | undefined): PullRequestRef | null {
  if (!owner || !repo || !num || !PART.test(owner) || !PART.test(repo) || !DIGITS.test(num) || num.length > 9) return null
  const number = Number(num)
  return number > 0 ? { owner, repo, number } : null
}

/** Parses https://github.com/<owner>/<repo>/pull/<n>[/files|/commits...][?..][#..]. Anything else is null. */
export function parsePullRequestUrl(href: string): PullRequestRef | null {
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return null
  }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com") return null
  const [owner, repo, kind, num] = url.pathname.split("/").filter(Boolean)
  return kind === "pull" ? build(owner, repo, num) : null
}

export function pullRequestPanelId(ref: PullRequestRef): string {
  return [ref.owner, ref.repo, ref.number].join("/")
}

export function parsePullRequestPanelId(id: string): PullRequestRef | null {
  const parts = id.split("/")
  return parts.length === 3 ? build(parts[0], parts[1], parts[2]) : null
}

export function pullRequestUrl(ref: PullRequestRef): string {
  return ["https://github.com", ref.owner, ref.repo, "pull", ref.number].join("/")
}

export function samePullRequest(a: PullRequestRef, b: PullRequestRef): boolean {
  return a.number === b.number && a.owner.toLowerCase() === b.owner.toLowerCase() && a.repo.toLowerCase() === b.repo.toLowerCase()
}

/**
 * True when a link's visible text is just the raw PR URL (e.g. a pasted bare URL or `<url>` autolink) rather than custom `[label](url)` text.
 */
export function isBarePullRequestLabel(label: string, pr: PullRequestRef, href?: string): boolean {
  const trimmed = label.trim()
  if (!trimmed) return true
  if (href && trimmed === href.trim()) return true
  const parsed = parsePullRequestUrl(trimmed)
  return parsed !== null && samePullRequest(parsed, pr)
}

/** Formats the resolved smart-chip label `#<number> <Title>`, avoiding `#123 #123` when GitHub returned no title. */
export function formatPullRequestLabel(summary: { number: number; title: string }): string {
  const prefix = `#${summary.number}`
  const title = summary.title.trim()
  return title && title !== prefix ? `${prefix} ${title}` : prefix
}
