import { validateDeployment, type Deployment, type PullRequest } from "./contracts"

export function required(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`Required configuration missing: ${name}`)
  return value
}
async function json<T>(url: string, token: string): Promise<T> {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(30_000) })
  if (!response.ok) throw new Error(`Deployment metadata request failed (${response.status})`)
  return response.json()
}
export async function resolveTarget(id = required("PREVIEW_DEPLOYMENT_ID")) {
  if (/^https:\/\/[a-z0-9-]+\.vercel\.app$/.test(id) && !/\s/.test(id)) id = new URL(id).hostname
  if (!/^dpl_[A-Za-z0-9]+$/.test(id) && !/^[a-z0-9-]+\.vercel\.app$/.test(id)) throw new Error("Use a Vercel deployment ID or URL")
  const d = await json<Deployment>(`https://api.vercel.com/v13/deployments/${id}?teamId=${encodeURIComponent(required("PREVIEW_VERCEL_TEAM_ID"))}`, required("PREVIEW_VERCEL_TOKEN"))
  if (!/^[1-9]\d{0,9}$/.test(d.meta?.githubPrId ?? "")) throw new Error("Deployment has no PR identity")
  const pr = await json<PullRequest>(`https://api.github.com/repos/rbcodelabs/compass/pulls/${d.meta.githubPrId}`, required("GITHUB_TOKEN"))
  return validateDeployment(d, pr, required("PREVIEW_VERCEL_PROJECT_ID"))
}
