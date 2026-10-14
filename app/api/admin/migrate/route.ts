import { createHash, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { Pool } from "pg";
import { DsqlSigner } from "@aws-sdk/dsql-signer";
import { awsCredentialsProvider } from "@vercel/functions/oidc";
import { getActiveSchema } from "@/lib/schema";
import { getManagedPilotContext } from "@/lib/preview-automation/managed-context";
import { createManagedMigrationPool } from "@/lib/preview-automation/managed-database";
import { initializeManagedPilot, applyManagedMigration, getManagedMigrationStatus, releaseManagedClaim } from "@/lib/preview-automation/managed-migrations";

export const dynamic = "force-dynamic";
// ASYNC_WAIT migrations (e.g. 047_research_voice_control_plane) create and wait
// on many ASYNC index jobs within one request. At 60s Vercel killed the function
// mid-migration, orphaning the managed claim. Keep within the plan limit (300s).
export const maxDuration = 300;

import { getMigrationStatus, applyMigrations } from "@/lib/migrations/runner";
import { repairWorkspaceIdResidual, WorkspaceIdBackfillRefusal } from "@/lib/migrations/workspace-id-on-solution-objective";
import { parseMigratePostBody } from "@/lib/migrations/admin-request";

async function getPool(): Promise<Pool> {
  // worktree-bootstrap provides a local Postgres URL. Keep local verification
  // on the exact same migration runner/search_path as DSQL deployments.
  if (process.env.DATABASE_URL) {
    return new Pool({ connectionString: process.env.DATABASE_URL, max: 3, query_timeout: 40_000 });
  }
  const host = process.env.PGHOST!;
  const signer = new DsqlSigner({
    credentials: awsCredentialsProvider({
      roleArn: process.env.AWS_ROLE_ARN!,
      clientConfig: { region: process.env.AWS_REGION },
    }),
    hostname: host,
    region: process.env.AWS_REGION ?? "us-east-1",
    expiresIn: 900,
  });

  return new Pool({
    host,
    user: process.env.PGUSER ?? "admin",
    database: process.env.PGDATABASE ?? "postgres",
    password: () => signer.getDbConnectAdminAuthToken(),
    port: 5432,
    ssl: true,
    max: 3,
    query_timeout: 40_000,
  });
}

function checkAuth(req: NextRequest): boolean {
  const secret = process.env.MIGRATION_SECRET;
  if (!secret) return false;
  // Constant-time compare (over fixed-length digests, so length is not leaked either).
  const given = createHash("sha256").update(req.headers.get("x-migration-secret") ?? "").digest();
  return timingSafeEqual(given, createHash("sha256").update(secret).digest());
}

export async function GET(req: NextRequest) {
  if (process.env.PREVIEW_DATABASE_MODE === "vercel-managed") return managedRequest(req, false);
  if (process.env.VERCEL_ENV === "preview" && process.env.PREVIEW_AUTOMATION_ENABLED === "1") return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!checkAuth(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = await getPool();
  try { return await getMigrationStatus(pool, getActiveSchema()); } finally { await pool.end(); }
}
export async function POST(req: NextRequest) {
  if (process.env.PREVIEW_DATABASE_MODE === "vercel-managed") return managedRequest(req, true);
  if (process.env.VERCEL_ENV === "preview" && process.env.PREVIEW_AUTOMATION_ENABLED === "1") return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!checkAuth(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // Only a truly empty body ({} or none) is the untargeted apply-pending flow. Anything malformed, non-object, carrying an
  // unknown key, a bad/empty/non-string script, or an unknown/ambiguous action is a 400 and never reaches the runner,
  // because the runner treats a missing script as POST-all (see lib/migrations/admin-request.ts).
  const parsed = parseMigratePostBody(await req.text());
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const pool = await getPool();
  try {
    // DELIBERATE EXCEPTION to "production data changes go through registered migrations": this is a repeatable, receiptless
    // residual backfill for solutions/objectives that old instances inserted with a NULL workspace_id after a receipted
    // migration. It only ever fills NULL workspace_id from the parent (idempotent, no DDL) and runs the same hook and
    // postconditions as 068/069, but it is NOT digest-pinned here (the hook file it calls is, in the managed manifest).
    // Because no receipt is written, every call logs one structured line (schema, counts, outcome; never a secret or row ids).
    if (parsed.kind === "backfill-workspace-id") {
      const schema = getActiveSchema();
      try {
        const result = await repairWorkspaceIdResidual(pool, schema);
        console.log(JSON.stringify({ event: "workspace-id-backfill", outcome: "ok", schema, before: result.before, after: result.after }));
        return NextResponse.json({ schema, ...result });
      } catch (error) {
        const detail = error as Error & { before?: unknown; log?: string[]; code?: string };
        if (error instanceof WorkspaceIdBackfillRefusal) {
          // Data-level refusal (postcondition failed / 068 not applied): the operator must act on the data.
          console.log(JSON.stringify({ event: "workspace-id-backfill", outcome: "refused", schema, before: detail.before, reason: detail.message }));
          return NextResponse.json({ schema, error: detail.message, before: detail.before, log: detail.log?.join("\n") }, { status: 409 });
        }
        // A server fault (connection, unexpected SQL error): not a postcondition, so 500 and no internals in the body.
        console.error(JSON.stringify({ event: "workspace-id-backfill", outcome: "error", schema, before: detail.before, errorName: detail.name, ...(detail.code ? { code: detail.code } : {}) }));
        return NextResponse.json({ schema, error: "Backfill failed unexpectedly; it is idempotent, so check the server logs and retry.", before: detail.before }, { status: 500 });
      }
    }
    return await applyMigrations(pool, getActiveSchema(), parsed.script);
  } finally { await pool.end(); }
}

async function managedRequest(req: NextRequest, write: boolean) {
  let context;
  try { context = getManagedPilotContext(); } catch { return NextResponse.json({ error: "Invalid managed pilot configuration" }, { status: 403 }); }
  if (!context || req.headers.get("x-preview-deployment-id") !== context.deploymentId) return NextResponse.json({ error: "Deployment mismatch" }, { status: 403 });
  if (!checkAuth(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = write ? await req.json().catch(() => null) : null;
  const scriptName = (value: unknown): value is string => typeof value === "string" && /^[0-9]{3}_[a-z0-9_]+$/.test(value);
  const release = write && body && typeof body === "object" && !Array.isArray(body) && Object.keys(body).length === 3 &&
    body.action === "release-claim" && typeof body.claim === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(body.claim) && scriptName(body.script);
  if (write && !release && (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1 ||
    !(body.action === "initialize" || scriptName(body.script)))) {
    return NextResponse.json({ error: "Use only action: initialize, one exact registered script, or an exact claim release" }, { status: 400 });
  }
  const pool = createManagedMigrationPool();
  try {
    if (!write) return await getManagedMigrationStatus(pool, context);
    if (body.action === "initialize") return await initializeManagedPilot(pool, context);
    if (release) return await releaseManagedClaim(pool, context, body.claim, body.script);
    return await applyManagedMigration(pool, context, body.script);
  } catch (error) {
    // Do not expose connection details or SQL; retained claims surface in GET.
    console.error("Managed pilot migration refused", error instanceof Error ? error.name : "Error");
    return NextResponse.json({ error: "Managed migration refused; inspect status and ownership before recovery" }, { status: 409 });
  } finally { await pool.end(); }
}
