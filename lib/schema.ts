/**
 * Returns the active PostgreSQL schema name for the current environment.
 *
 * The schema name is always "{prefix}_{suffix}" where:
 *   - prefix: PGSCHEMA env var if set, otherwise "compass"
 *   - suffix: derived from the current environment
 *       NODE_ENV=development  → "dev"
 *       VERCEL_ENV=preview    → "preview"
 *       VERCEL_ENV=production → "prod"
 *
 * Examples with PGSCHEMA=compass: compass_dev, compass_preview, compass_prod
 */
export function getActiveSchema(): string {
  if (process.env.PREVIEW_AUTOMATION_ENABLED === "1") {
    const pr = process.env.VERCEL_GIT_PULL_REQUEST_ID ?? "";
    const sha = process.env.VERCEL_GIT_COMMIT_SHA ?? "";
    if (process.env.VERCEL_ENV !== "preview" || !/^[1-9]\d{0,9}$/.test(pr) || !/^[a-f0-9]{40}$/.test(sha)) {
      throw new Error("Invalid preview automation deployment metadata");
    }
    return `compass_pr_${pr}_${sha.slice(0, 12)}`;
  }
  const prefix = process.env.PGSCHEMA ?? "compass";

  if (process.env.NODE_ENV === "development") return `${prefix}_dev`;

  const vercelEnv = process.env.VERCEL_ENV;
  if (vercelEnv === "preview") return `${prefix}_preview`;
  if (vercelEnv === "production") return `${prefix}_prod`;

  return `${prefix}_dev`;
}
