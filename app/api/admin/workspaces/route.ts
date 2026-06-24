import { NextRequest, NextResponse } from "next/server";
import { Pool } from "pg";
import { DsqlSigner } from "@aws-sdk/dsql-signer";
import { awsCredentialsProvider } from "@vercel/functions/oidc";
import { getActiveSchema } from "@/lib/schema";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

async function getPool(): Promise<Pool> {
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
  });
}

function checkAuth(req: NextRequest): boolean {
  const secret = process.env.MIGRATION_SECRET;
  if (!secret) return false;
  return req.headers.get("x-migration-secret") === secret;
}

export async function GET(req: NextRequest) {
  if (!checkAuth(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const schema = getActiveSchema();
  const pool = await getPool();
  const client = await pool.connect();

  try {
    const { rows: workspaces } = await client.query(`
      SELECT
        o.id   AS org_id,
        o.name AS org_name,
        o.slug AS org_slug,
        w.id   AS workspace_id,
        w.name AS workspace_name,
        w.slug AS workspace_slug
      FROM "${schema}".organizations o
      JOIN "${schema}".workspaces w ON w.organization_id = o.id
      ORDER BY o.name, w.name
    `);

    const { rows: users } = await client.query(`
      SELECT id, name, email, "created_at"
      FROM "${schema}".users
      ORDER BY "created_at" ASC
      LIMIT 20
    `);

    return NextResponse.json({ schema, workspaces, users });
  } finally {
    client.release();
    await pool.end();
  }
}
