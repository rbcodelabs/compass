import { randomUUID, sign } from "node:crypto"

export function schemaFor(pr: string | number, sha: string) {
  if (/\s/.test(String(pr) + sha) || !/^[1-9]\d{0,9}$/.test(String(pr)) || !/^[a-f0-9]{40}$/.test(sha)) throw new Error("Invalid preview revision")
  return `compass_pr_${pr}_${sha.slice(0, 12)}`
}
export interface Deployment {
  id: string; url: string; projectId: string; readyState: string; target: string | null
  meta: { githubCommitSha?: string; githubCommitOrg?: string; githubCommitRepo?: string; githubPrId?: string }
}
export interface PullRequest {
  number: number; state: string
  user?: { login: string; type?: string }
  head: { sha: string; repo: { full_name: string } | null }
  base: { repo: { full_name: string } }
}
export function validateDeployment(d: Deployment, pr: PullRequest, projectId: string) {
  const repo = "rbcodelabs/compass"
  if (d.projectId !== projectId || !projectId || d.readyState !== "READY" || d.target === "production" || !/^dpl_[A-Za-z0-9]+$/.test(d.id)
    || /\s/.test(d.url + d.id) || !/^[a-z0-9-]+\.vercel\.app$/.test(d.url) || d.url.includes("-git-")
    || pr.state !== "open" || pr.head.repo?.full_name !== repo || pr.base.repo.full_name !== repo
    || pr.user?.type === "Bot" || pr.user?.login.endsWith("[bot]")
    || `${d.meta.githubCommitOrg}/${d.meta.githubCommitRepo}` !== repo || d.meta.githubCommitSha !== pr.head.sha
    || String(pr.number) !== d.meta.githubPrId) throw new Error("Deployment is not a current trusted Compass PR preview")
  return { deploymentId: d.id, origin: `https://${d.url}`, schema: schemaFor(pr.number, pr.head.sha), sha: pr.head.sha, pr: pr.number }
}
export function originHeaders(origin: string, url: string, bypass: string): Record<string, string> {
  return new URL(url).origin === origin && bypass ? { "x-vercel-protection-bypass": bypass } : {}
}
export interface GrantInput { deploymentId: string; origin: string; runId: string; operation: "bootstrap" | "session" | "teardown"; persona?: "owner" | "viewer"; scenario?: "empty" | "full-data" | "mid-okr-cycle" }
export function signGrant(input: GrantInput, privateKey: string, now = Math.floor(Date.now() / 1000), expiresNoLaterThan = now + 300) {
  const exp = Math.min(now + 300, Math.floor(expiresNoLaterThan))
  if (!Number.isFinite(exp) || exp <= now) throw new Error("No valid grant interval remains")
  const encoded = Buffer.from(JSON.stringify({ v: 1, iss: "compass-preview-controller", aud: "compass-preview-automation", ...input, nonce: randomUUID(), iat: now, exp })).toString("base64url")
  return `${encoded}.${sign(null, Buffer.from(encoded), privateKey).toString("base64url")}`
}
