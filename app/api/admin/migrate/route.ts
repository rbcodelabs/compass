import { NextRequest, NextResponse } from "next/server";
import { Pool } from "pg";
import { DsqlSigner } from "@aws-sdk/dsql-signer";
import { awsCredentialsProvider } from "@vercel/functions/oidc";
import { getActiveSchema } from "@/lib/schema";
import { getManagedPilotContext } from "@/lib/preview-automation/managed-context";
import { createManagedMigrationPool } from "@/lib/preview-automation/managed-database";
import { initializeManagedPilot, applyManagedMigration, getManagedMigrationStatus } from "@/lib/preview-automation/managed-migrations";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

import { getMigrationStatus, applyMigrations } from "@/lib/migrations/runner";
export { normalizeConstraintDefinition } from "@/lib/migrations/runner";
export { getDecisionGateExpectedCatalog, getDecisionGateInfrastructureHealth } from "@/lib/migrations/runner";

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
  return req.headers.get("x-migration-secret") === secret;
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
  const body = await req.json().catch(() => ({}));
  const pool = await getPool();
  try { return await applyMigrations(pool, getActiveSchema(), body.script); } finally { await pool.end(); }
}

async function managedRequest(req: NextRequest, write: boolean) {
  let context;
  try { context = getManagedPilotContext(); } catch { return NextResponse.json({ error: "Invalid managed pilot configuration" }, { status: 403 }); }
  if (!context || req.headers.get("x-preview-deployment-id") !== context.deploymentId) return NextResponse.json({ error: "Deployment mismatch" }, { status: 403 });
  if (!checkAuth(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = write ? await req.json().catch(() => null) : null;
  if (write && (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1 ||
    !(body.action === "initialize" || (typeof body.script === "string" && /^[0-9]{3}_[a-z0-9_]+$/.test(body.script))))) {
    return NextResponse.json({ error: "Use only action: initialize or one exact registered script" }, { status: 400 });
  }
  const pool = createManagedMigrationPool();
  try {
    if (!write) return await getManagedMigrationStatus(pool, context);
    if (body.action === "initialize") return await initializeManagedPilot(pool, context);
    return await applyManagedMigration(pool, context, body.script);
  } catch (error) {
    // Do not expose connection details or SQL; retained claims surface in GET.
    console.error("Managed pilot migration refused", error instanceof Error ? error.name : "Error");
    return NextResponse.json({ error: "Managed migration refused; inspect status and ownership before recovery" }, { status: 409 });
  } finally { await pool.end(); }
}
