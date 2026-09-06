import { NextRequest, NextResponse } from "next/server";
import { Pool } from "pg";
import { DsqlSigner } from "@aws-sdk/dsql-signer";
import { awsCredentialsProvider } from "@vercel/functions/oidc";
import { getActiveSchema } from "@/lib/schema";

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
  if (process.env.VERCEL_ENV === "preview" && process.env.PREVIEW_AUTOMATION_ENABLED === "1") return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!checkAuth(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = await getPool();
  try { return await getMigrationStatus(pool, getActiveSchema()); } finally { await pool.end(); }
}
export async function POST(req: NextRequest) {
  if (process.env.VERCEL_ENV === "preview" && process.env.PREVIEW_AUTOMATION_ENABLED === "1") return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!checkAuth(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const pool = await getPool();
  try { return await applyMigrations(pool, getActiveSchema(), body.script); } finally { await pool.end(); }
}
