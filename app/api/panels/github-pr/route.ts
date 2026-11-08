import { NextResponse } from "next/server"
import { auth } from "@/auth"
import { getWorkspace } from "@/lib/workspace"
import getPrisma from "@/lib/db"
import { readWorkspaceAgentRepos } from "@/lib/agent-github-repos"
import { parsePullRequestPanelId } from "@/lib/github-pull-request-links"
import { fetchPullRequestSummary } from "@/lib/github-pull-request-summary"

/**
 * Data source for the PR chip and sidebar. GET /api/panels/github-pr?orgSlug=&workspaceSlug=&id=<owner>/<repo>/<number>
 *
 * Same access rule as the other panel routes (session + workspace membership), plus: the repo must be on the workspace's approved
 * agent repo list. Anything else 404s exactly like a PR that does not exist, so the endpoint cannot be used to probe other repos.
 */
export async function GET(req: Request) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const orgSlug = searchParams.get("orgSlug")
  const workspaceSlug = searchParams.get("workspaceSlug")
  const id = searchParams.get("id")
  if (!orgSlug || !workspaceSlug || !id) return NextResponse.json({ error: "orgSlug, workspaceSlug and id are required" }, { status: 400 })

  const ref = parsePullRequestPanelId(id)
  if (!ref) return NextResponse.json({ error: "Invalid pull request id" }, { status: 400 })

  const workspace = await getWorkspace(orgSlug, workspaceSlug, session.user.id)
  if (!workspace) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const approved = await readWorkspaceAgentRepos(getPrisma(), workspace.id)
  const wanted = (ref.owner + "/" + ref.repo).toLowerCase()
  if (!approved.some((r) => r.toLowerCase() === wanted)) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const result = await fetchPullRequestSummary(ref)
  if (!result.ok) {
    if (result.reason === "not_found") return NextResponse.json({ error: "Not found" }, { status: 404 })
    return NextResponse.json({ error: result.reason }, { status: result.reason === "not_configured" ? 503 : 502 })
  }
  return NextResponse.json(result.summary)
}
