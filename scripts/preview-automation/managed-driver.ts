/** Must exceed the migrate route maxDuration (300s) so a POST is never abandoned while the server still runs it. */
export const MIGRATION_POST_TIMEOUT_MS = 310_000;
type Target = { deploymentId: string; origin: string; schema: string; sha: string; pr: number };
/** Target must first come from resolveTarget's independent Vercel/GitHub checks. */
export async function runManagedMigration(target: Target, operation: string, secret: string, bypass: string, fetcher: typeof fetch = fetch) {
  if (target.pr !== 276 || !/^https:\/\/[a-z0-9-]+\.vercel\.app$/.test(target.origin) || target.origin.includes("-git-") ||
    !/^dpl_[A-Za-z0-9]+$/.test(target.deploymentId) || !/^[a-f0-9]{40}$/.test(target.sha) || target.schema !== `compass_pr_276_${target.sha.slice(0, 12)}`) throw new Error("Only immutable PR276 deployment is allowed");
  if (!secret || !bypass) throw new Error("Preview migration and protection credentials required");
  if (!["status", "initialize"].includes(operation) && !/^[0-9]{3}_[a-z0-9_]+$/.test(operation)) throw new Error("Use status, initialize or exact registered migration name");
  const headers = { "x-migration-secret": secret, "x-vercel-protection-bypass": bypass, "x-preview-deployment-id": target.deploymentId, "content-type": "application/json" };
  const url = `${target.origin}/api/admin/migrate`;
  async function status() {
    const response = await fetcher(url, { method: "GET", headers, redirect: "error", signal: AbortSignal.timeout(55_000) });
    if (!response.ok) throw new Error(`Managed status unavailable (${response.status}); inspect ownership, do not retry writes`);
    const body = await response.json();
    if (body.schema !== target.schema || !body.managed || !Array.isArray(body.pending)) throw new Error("Unexpected managed status identity");
    return body;
  }
  if (operation === "status") return { httpStatus: 200, status: await status() };
  if (operation !== "initialize") {
    const before = await status();
    if (before.managed.owner?.claimed_by) throw new Error("Existing claim requires inspected recovery");
    if (before.pending[0] !== operation) throw new Error("Only the first exact pending migration may be advanced");
  }
  let response: Response;
  try {
    response = await fetcher(url, { method: "POST", headers, redirect: "error", signal: AbortSignal.timeout(MIGRATION_POST_TIMEOUT_MS),
      body: JSON.stringify(operation === "initialize" ? { action: "initialize" } : { script: operation }) });
  } catch { throw new Error("Migration POST outcome unknown; inspect status before any further action. No retry attempted"); }
  if (!response.ok) throw new Error(`Migration refused (${response.status}); inspect status before recovery.${await failureDetail(response)}`);
  return { httpStatus: response.status, result: await response.json(), status: await status() };
}

/** Server error text and the last runner log lines; never headers or credentials. */
async function failureDetail(response: Response) {
  const body = await response.json().catch(() => null) as { error?: unknown; log?: unknown } | null;
  if (!body) return "";
  const error = typeof body.error === "string" ? ` Error: ${body.error.slice(0, 500)}` : "";
  const log = typeof body.log === "string" ? ` Log tail: ${body.log.split("\n").slice(-15).join(" | ").slice(0, 2000)}` : "";
  return error + log;
}

/** Reviewed recovery: release a retained claim only when status shows that exact claim on that exact migration. */
export async function releaseManagedClaim(target: Target, script: string, claim: string, secret: string, bypass: string, fetcher: typeof fetch = fetch) {
  const before = await runManagedMigration(target, "status", secret, bypass, fetcher);
  const owner = before.status.managed.owner;
  if (owner?.claimed_by !== claim || owner?.claim_script !== script || before.status.pending[0] !== script) throw new Error("Status does not show that exact claim on the first pending migration; nothing released");
  const headers = { "x-migration-secret": secret, "x-vercel-protection-bypass": bypass, "x-preview-deployment-id": target.deploymentId, "content-type": "application/json" };
  const response = await fetcher(`${target.origin}/api/admin/migrate`, { method: "POST", headers, redirect: "error", signal: AbortSignal.timeout(55_000), body: JSON.stringify({ action: "release-claim", claim, script }) });
  if (!response.ok) throw new Error(`Claim release refused (${response.status}).${await failureDetail(response)}`);
  const after = await runManagedMigration(target, "status", secret, bypass, fetcher);
  return { httpStatus: response.status, result: await response.json(), status: after.status };
}
