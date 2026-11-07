import { mintRepoInstallationToken, githubConnectorUid } from "@/lib/github-app-token"
import {
  releaseSourceFingerprint,
  unconfiguredReleaseSourceRevalidator,
  type ReleaseScope,
  type ReleaseSourceRevalidation,
  type ReleaseSourceRevalidator,
} from "@/lib/release-authorization"

/**
 * Release policies are operator configuration, not user input. A policy id the
 * deployment does not know about fails closed as POLICY_CHANGED.
 *
 * COMPASS_RELEASE_POLICIES='{"default":{"requiredChecks":["build","test"]}}'
 */
export const RELEASE_POLICIES_ENV = "COMPASS_RELEASE_POLICIES"

export type ReleasePolicy = {
  /** Check-run / status names that must exist and succeed. Every reported check must succeed regardless, and at least one must exist. */
  requiredChecks: string[]
}

export type ReleasePolicyResolver = (policyId: string) => ReleasePolicy | null

export function releasePoliciesFromEnv(raw: string | undefined = process.env[RELEASE_POLICIES_ENV]): ReleasePolicyResolver {
  let parsed: Record<string, { requiredChecks?: unknown }> = {}
  try {
    const value = raw ? JSON.parse(raw) : {}
    if (value && typeof value === "object" && !Array.isArray(value)) parsed = value
  } catch {
    parsed = {}
  }
  return (policyId) => {
    if (!Object.prototype.hasOwnProperty.call(parsed, policyId)) return null
    const entry = parsed[policyId]
    const checks = Array.isArray(entry?.requiredChecks)
      ? entry.requiredChecks.filter((c): c is string => typeof c === "string" && c.length > 0)
      : []
    return { requiredChecks: checks }
  }
}

export const RELEASE_READ_PERMISSIONS = ["pull_requests:read", "checks:read", "statuses:read", "metadata:read"] as const

const PASSING_CONCLUSIONS = new Set(["success", "neutral", "skipped"])
const MAX_PAGES = 10

export type GitHubReleaseRevalidatorDeps = {
  fetcher?: typeof fetch
  mintToken?: (repo: { owner: string; names: string[]; permissions: readonly string[] }) => Promise<{ token: string }>
  policies?: ReleasePolicyResolver
}

type PullRequest = {
  state?: string
  draft?: boolean
  merged?: boolean
  mergeable?: boolean | null
  base?: { ref?: string }
  head?: { sha?: string }
}
type CheckRun = { name?: string; status?: string; conclusion?: string | null }
type CheckRunsPage = { total_count?: number; check_runs?: CheckRun[] }
type CombinedStatus = { statuses?: { context?: string; state?: string }[] }
type CheckResults = Map<string, boolean>

const blocked = (code: "PR_NOT_READY" | "CHECKS_FAILED" | "POLICY_CHANGED", detail: string): ReleaseSourceRevalidation => ({
  status: "BLOCKED",
  code,
  detail,
})

/**
 * Reads the live PR and head-commit check state from GitHub with a short-lived,
 * read-only installation token. It never writes. Any unexpected response,
 * transport error or missing signal is a block, never a pass (queueAuthorizedRelease
 * maps a thrown error to PR_NOT_READY).
 */
export function createGitHubReleaseSourceRevalidator(deps: GitHubReleaseRevalidatorDeps = {}): ReleaseSourceRevalidator {
  const fetcher = deps.fetcher ?? fetch
  const mint = deps.mintToken ?? ((repo) => mintRepoInstallationToken(repo))
  const policies = deps.policies ?? releasePoliciesFromEnv()

  return {
    async revalidate(scope: ReleaseScope): Promise<ReleaseSourceRevalidation> {
      if (scope.provider !== "GITHUB") return blocked("PR_NOT_READY", "Unsupported provider.")
      const policy = policies(scope.releasePolicyId)
      if (!policy) return blocked("POLICY_CHANGED", "Release policy is not configured.")

      const { token } = await mint({ owner: scope.repositoryOwner, names: [scope.repositoryName], permissions: RELEASE_READ_PERMISSIONS })
      const root = "https://api.github.com/repos/" + encodeURIComponent(scope.repositoryOwner) + "/" + encodeURIComponent(scope.repositoryName)
      const headers = { Authorization: "Bearer " + token, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" }
      async function get<T> (url: string): Promise<T> {
        const res = await fetcher(url, { headers, cache: "no-store" })
        if (!res.ok) throw new Error("GitHub request failed (" + res.status + ")")
        return (await res.json()) as T
      }

      const pr = await get<PullRequest> (root + "/pulls/" + scope.pullRequestNumber)
      if (pr.state !== "open" || pr.merged === true) return blocked("PR_NOT_READY", "Pull request is not open.")
      if (pr.draft === true) return blocked("PR_NOT_READY", "Pull request is a draft.")
      if (pr.base?.ref !== scope.baseRef) return blocked("PR_NOT_READY", "Base branch changed.")
      if (pr.head?.sha?.toLowerCase() !== scope.headSha.toLowerCase()) return blocked("PR_NOT_READY", "Head commit changed since review.")
      if (pr.mergeable === false) return blocked("PR_NOT_READY", "Pull request has conflicts.")

      const runs: CheckRun[] = []
      for (let page = 1; page <= MAX_PAGES; page++) {
        const body = await get<CheckRunsPage> (root + "/commits/" + scope.headSha + "/check-runs?per_page=100&page=" + page)
        const batch = body.check_runs ?? []
        runs.push(...batch)
        if (batch.length < 100 || runs.length >= (body.total_count ?? 0)) break
      }
      const combined = await get<CombinedStatus> (root + "/commits/" + scope.headSha + "/status")

      const results: CheckResults = new Map ()
      const record = (name: string | undefined, passed: boolean) => {
        if (!name) return
        results.set(name, (results.get(name) ?? true) && passed)
      }
      for (const run of runs) record(run.name, run.status === "completed" && PASSING_CONCLUSIONS.has(run.conclusion ?? ""))
      for (const status of combined.statuses ?? []) record(status.context, status.state === "success")

      if (results.size === 0) return blocked("CHECKS_FAILED", "No checks reported for the head commit.")
      for (const name of policy.requiredChecks) {
        if (!results.has(name)) return blocked("CHECKS_FAILED", 'Required check "' + name + '" has not reported.')
      }
      for (const [name, passed] of results) {
        if (!passed) return blocked("CHECKS_FAILED", 'Check "' + name + '" has not passed.')
      }

      return { status: "VALID", snapshot: { scope, fingerprint: releaseSourceFingerprint(scope) } }
    },
  }
}

/** GitHub-backed when the App connector is configured; otherwise the fail-closed stub. */
export function getReleaseSourceRevalidator(): ReleaseSourceRevalidator {
  return githubConnectorUid() ? createGitHubReleaseSourceRevalidator() : unconfiguredReleaseSourceRevalidator
}
