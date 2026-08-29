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

/** POST body: { orgSlug, orgName, workspaceSlug, workspaceName, userEmail, apiKeyLabel? } */
export async function POST(req: NextRequest) {
  if (!checkAuth(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const schema = getActiveSchema();
  const body = await req.json();
  const { orgSlug, orgName, workspaceSlug, workspaceName, userEmail, apiKeyLabel, feedbackEnabled = false, roadmapPublic = false } = body;
  const feedbackEnabledBool: boolean = Boolean(feedbackEnabled);
  const roadmapPublicBool: boolean = Boolean(roadmapPublic);

  if (!orgSlug || !orgName || !workspaceSlug || !workspaceName || !userEmail) {
    return NextResponse.json({ error: "Missing required fields: orgSlug, orgName, workspaceSlug, workspaceName, userEmail" }, { status: 400 });
  }

  const pool = await getPool();
  const client = await pool.connect();

  try {
    const log: string[] = [];

    // Find user
    const userRes = await client.query(`SELECT id FROM "${schema}".users WHERE email = $1`, [userEmail]);
    if (!userRes.rows[0]) {
      return NextResponse.json({ error: `User ${userEmail} not found` }, { status: 404 });
    }
    const userId = userRes.rows[0].id;

    // Upsert org
    let orgRes = await client.query(`SELECT id FROM "${schema}".organizations WHERE slug = $1`, [orgSlug]);
    if (!orgRes.rows[0]) {
      orgRes = await client.query(
        `INSERT INTO "${schema}".organizations (name, slug) VALUES ($1, $2) RETURNING id`,
        [orgName, orgSlug]
      );
      log.push(`Created org: ${orgName} (${orgSlug})`);
    } else {
      // Also update name and slug in case we're renaming
      await client.query(`UPDATE "${schema}".organizations SET name = $1, slug = $2 WHERE id = $3`, [orgName, orgSlug, orgRes.rows[0].id]);
      log.push(`Updated org: ${orgName} (${orgSlug})`);
    }
    const orgId: string = orgRes.rows[0].id;

    // Upsert workspace
    let wsRes = await client.query(
      `SELECT id FROM "${schema}".workspaces WHERE organization_id = $1 AND slug = $2`,
      [orgId, workspaceSlug]
    );
    if (!wsRes.rows[0]) {
      wsRes = await client.query(
        `INSERT INTO "${schema}".workspaces (organization_id, name, slug, feedback_enabled, roadmap_public) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [orgId, workspaceName, workspaceSlug, feedbackEnabledBool, roadmapPublicBool]
      );
      log.push(`Created workspace: ${workspaceName} (${workspaceSlug})`);
    } else {
      await client.query(
        `UPDATE "${schema}".workspaces SET feedback_enabled = $1, roadmap_public = $2 WHERE id = $3`,
        [feedbackEnabledBool, roadmapPublicBool, wsRes.rows[0].id]
      );
      log.push(`Updated workspace flags: ${workspaceName} (feedbackEnabled=${feedbackEnabledBool}, roadmapPublic=${roadmapPublicBool})`);
    }
    const wsId: string = wsRes.rows[0].id;

    // Upsert membership
    const memRes = await client.query(
      `SELECT id FROM "${schema}".workspace_members WHERE workspace_id = $1 AND user_id = $2`,
      [wsId, userId]
    );
    if (!memRes.rows[0]) {
      await client.query(
        `INSERT INTO "${schema}".workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'ADMIN')`,
        [wsId, userId]
      );
      log.push(`Added user ${userEmail} as workspace ADMIN`);
    }

    // Create API key (api_keys schema: id, user_id, name, key_hash, key_prefix, last_used_at, revoked_at, created_at)
    const { createHash, randomBytes } = await import("crypto");
    const apiKey = randomBytes(32).toString("hex");
    const keyHash = createHash("sha256").update(apiKey).digest("hex");
    const keyPrefix = apiKey.slice(0, 8);
    const keyName = apiKeyLabel ?? "MCP access";
    const existingKey = await client.query(
      `SELECT id FROM "${schema}".api_keys WHERE user_id = $1 AND name = $2`,
      [userId, keyName]
    );
    if (!existingKey.rows[0]) {
      await client.query(
        `INSERT INTO "${schema}".api_keys (user_id, name, key_hash, key_prefix) VALUES ($1, $2, $3, $4)`,
        [userId, keyName, keyHash, keyPrefix]
      );
      log.push(`API key created (prefix: ${keyPrefix})`);
      return NextResponse.json({ log, orgId, workspaceId: wsId, apiKey, url: `/${orgSlug}/${workspaceSlug}/okrs` });
    }

    return NextResponse.json({ log, orgId, workspaceId: wsId, url: `/${orgSlug}/${workspaceSlug}/okrs` });
  } finally {
    client.release();
    await pool.end();
  }
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
