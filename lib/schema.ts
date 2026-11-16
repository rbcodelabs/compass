/**
 * Returns the active PostgreSQL schema name for the current environment.
 *
 * The schema name is always "{prefix}_{suffix}" where:
 *   - prefix: PGSCHEMA env var if set, otherwise "compass"
 *   - suffix: derived from the current environment
 *       NODE_ENV=development  → "dev"
 *       COMPASS_ENV=preview   → "preview"   (VERCEL_ENV on Vercel, see lib/runtime-env.ts)
 *       COMPASS_ENV=production→ "prod"
 *
 * Examples with PGSCHEMA=compass: compass_dev, compass_preview, compass_prod
 */
import { compassEnv } from "@/lib/runtime-env";
import { getManagedPilotContext } from "./preview-automation/managed-context";

export function getActiveSchema(env: NodeJS.ProcessEnv = process.env): string {
  const managed = getManagedPilotContext(env);
  if (managed) return managed.schema;
  if (env.PREVIEW_AUTOMATION_ENABLED === "1") {
    const pr = env.VERCEL_GIT_PULL_REQUEST_ID ?? "";
    const sha = env.VERCEL_GIT_COMMIT_SHA ?? "";
    if (compassEnv(env) !== "preview" || !/^[1-9]\d{0,9}$/.test(pr) || !/^[a-f0-9]{40}$/.test(sha)) {
      throw new Error("Invalid preview automation deployment metadata");
    }
    return `compass_pr_${pr}_${sha.slice(0, 12)}`;
  }
  const prefix = env.PGSCHEMA ?? "compass";

  if (env.NODE_ENV === "development") return `${prefix}_dev`;

  const resolvedEnv = compassEnv(env);
  if (resolvedEnv === "preview") return `${prefix}_preview`;
  if (resolvedEnv === "production") return `${prefix}_prod`;

  return `${prefix}_dev`;
}
