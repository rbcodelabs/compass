import { mintRepoInstallationToken, githubConnectorUid } from "@/lib/github-app-token"
import { pullRequestUrl, type PullRequestRef } from "@/lib/github-pull-request-links"

export type PullRequestState = "open" | "draft" | "merged" | "closed"
export type PullRequestChecks = "passing" | "failing" | "pending" | "none" | "unknown"

export type PullRequestSummary = {
  owner: string
  repo: string
  number: number
  url: string
  title: string
  state: PullRequestState
  author: string | null
  baseRef: string
  headRef: string
  body: string | null
  additions: number
  deletions: number
  changedFiles: number
  commits: number
  comments: number
  reviewComments: number
  mergeable: boolean | null
  checks: PullRequestChecks
  failingChecks: string[]
  updatedAt: string | null
}

export const PR_READ_PERMISSIONS = ["pull_requests:read", "checks:read", "statuses:read", "metadata:read"] as const
/** Fallback when the App has not been granted the checks permissions: the PR still loads, checks read as unavailable. */
export const PR_BASIC_PERMISSIONS = ["pull_requests:read", "metadata:read"] as const

type GhPull = {
  html_url?: string
  title?: string
  state?: string
  draft?: boolean
  merged?: boolean
  user?: { login?: string } | null
  base?: { ref?: string }
  head?: { ref?: string; sha?: string }
  body?: string | null
  additions?: number
  deletions?: number
  changed_files?: number
  commits?: number
  comments?: number
  review_comments?: number
  mergeable?: boolean | null
  updated_at?: string
}
type GhRun = { name?: string; status?: string; conclusion?: string | null }
type GhStatus = { context?: string; state?: string }

const OK = new Set(["success", "neutral", "skipped"])
const SHA = /^[a-f0-9]+$/i

export function prState(pr: Pick<GhPull, "state" | "draft" | "merged">): PullRequestState {
  if (pr.merged) return "merged"
  if (pr.state === "closed") return "closed"
  return pr.draft ? "draft" : "open"
}

/** Folds check runs and commit statuses into one verdict. Any failure wins; otherwise anything unfinished is pending. */
export function summarizeChecks(runs: GhRun[] | undefined, statuses: GhStatus[] | undefined): { checks: PullRequestChecks; failing: string[] } {
  const failing: string[] = []
  let pending = false
  let total = 0
  for (const run of runs ?? []) {
    total++
    if (run.status !== "completed") pending = true
    else if (!OK.has(run.conclusion ?? "")) failing.push(run.name ?? "check")
  }
  for (const s of statuses ?? []) {
    total++
    if (s.state === "pending") pending = true
    else if (s.state !== "success") failing.push(s.context ?? "status")
  }
  if (total === 0) return { checks: "none", failing }
  if (failing.length) return { checks: "failing", failing }
  return { checks: pending ? "pending" : "passing", failing }
}

export type PullRequestFetchResult = { ok: true; summary: PullRequestSummary } | { ok: false; reason: "not_configured" | "not_found" | "error" }

/**
 * Reads one PR with a short-lived read-only installation token. Never writes. The caller must already have checked that the repo
 * is one of the workspace's approved agent repos. Check data is best effort: a missing permission yields "unknown", not an error.
 */
export async function fetchPullRequestSummary(ref: PullRequestRef, fetcher: typeof fetch = fetch): Promise<PullRequestFetchResult> {
  if (!githubConnectorUid()) return { ok: false, reason: "not_configured" }
  try {
    const target = { owner: ref.owner, names: [ref.repo] }
    let token: string
    let canReadChecks = true
    try {
      token = (await mintRepoInstallationToken({ ...target, permissions: PR_READ_PERMISSIONS })).token
    } catch {
      // Connect refuses a token when the App lacks any requested permission, so retry without the checks permissions.
      canReadChecks = false
      token = (await mintRepoInstallationToken({ ...target, permissions: PR_BASIC_PERMISSIONS })).token
    }
    const root = ["https://api.github.com/repos", encodeURIComponent(ref.owner), encodeURIComponent(ref.repo)].join("/")
    const headers = { Authorization: "Bearer " + token, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" }
    const res = await fetcher(root + "/pulls/" + ref.number, { headers, cache: "no-store" })
    if (res.status === 404) return { ok: false, reason: "not_found" }
    if (!res.ok) return { ok: false, reason: "error" }
    const pr = (await res.json()) as GhPull

    let checks: PullRequestChecks = "unknown"
    let failing: string[] = []
    const sha = pr.head?.sha
    if (canReadChecks && sha && sha.length === 40 && SHA.test(sha)) {
      const [runs, status] = await Promise.all([
        fetcher(root + "/commits/" + sha + "/check-runs?per_page=100", { headers, cache: "no-store" }),
        fetcher(root + "/commits/" + sha + "/status", { headers, cache: "no-store" }),
      ])
      if (runs.ok && status.ok) {
        const folded = summarizeChecks(((await runs.json()) as { check_runs?: GhRun[] }).check_runs, ((await status.json()) as { statuses?: GhStatus[] }).statuses)
        checks = folded.checks
        failing = folded.failing
      }
    }

    return {
      ok: true,
      summary: {
        owner: ref.owner,
        repo: ref.repo,
        number: ref.number,
        url: pr.html_url ?? pullRequestUrl(ref),
        title: pr.title ?? "#" + ref.number,
        state: prState(pr),
        author: pr.user?.login ?? null,
        baseRef: pr.base?.ref ?? "",
        headRef: pr.head?.ref ?? "",
        body: pr.body ?? null,
        additions: pr.additions ?? 0,
        deletions: pr.deletions ?? 0,
        changedFiles: pr.changed_files ?? 0,
        commits: pr.commits ?? 0,
        comments: pr.comments ?? 0,
        reviewComments: pr.review_comments ?? 0,
        mergeable: pr.mergeable ?? null,
        checks,
        failingChecks: failing.slice(0, 10),
        updatedAt: pr.updated_at ?? null,
      },
    }
  } catch {
    // Never echo upstream detail to the browser.
    return { ok: false, reason: "error" }
  }
}
