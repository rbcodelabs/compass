/** Explicit risk-accepted pilot. This validates routing, not database permissions. */
export interface ManagedPilotContext {
  schema: string;
  pr: string;
  sha: string;
  deploymentId: string;
  origin: string;
  runId: string;
  workspaceId: string;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function getManagedPilotContext(env: NodeJS.ProcessEnv = process.env): ManagedPilotContext | null {
  if (!env.PREVIEW_DATABASE_MODE || env.PREVIEW_DATABASE_MODE === "scoped-role") return null;
  const { VERCEL_GIT_PULL_REQUEST_ID: pr = "", VERCEL_GIT_COMMIT_SHA: sha = "",
    VERCEL_DEPLOYMENT_ID: deploymentId = "", VERCEL_URL: hostname = "",
    PREVIEW_MANAGED_RUN_ID: runId = "", PREVIEW_MANAGED_WORKSPACE_ID: workspaceId = "" } = env;
  if (env.PREVIEW_DATABASE_MODE !== "vercel-managed" || env.VERCEL_ENV !== "preview" ||
    env.PREVIEW_AUTOMATION_ENABLED !== "1" || pr !== "276" || !/^[a-f0-9]{40}$/.test(sha) ||
    env.VERCEL_GIT_REPO_OWNER !== "rbcodelabs" || env.VERCEL_GIT_REPO_SLUG !== "compass" ||
    env.VERCEL_GIT_COMMIT_REF !== "feat/geode-docs-preview-pilot" || !/^dpl_[A-Za-z0-9]+$/.test(deploymentId) ||
    !/^[a-z0-9-]+\.vercel\.app$/.test(hostname) || !uuid.test(runId) || !uuid.test(workspaceId) ||
    env.PGSCHEMA || env.DATABASE_URL) {
    throw new Error("Invalid Vercel-managed pilot configuration");
  }
  return { schema: `compass_pr_${pr}_${sha.slice(0, 12)}`, pr, sha, deploymentId,
    origin: `https://${hostname}`, runId, workspaceId };
}
