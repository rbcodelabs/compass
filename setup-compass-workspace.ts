#!/usr/bin/env node
/**
 * Production setup: rename org slug to rbcodelabs + create compass workspace
 * Run via: vercel env run --environment=production --scope rbcodelabs-team --cwd /Users/rickbowman/projects/compass -- node /tmp/setup-compass-workspace.ts
 */

import pg from "pg";
import { DsqlSigner } from "@aws-sdk/dsql-signer";
import { awsCredentialsProvider } from "@vercel/functions/oidc";
import crypto from "crypto";

const { Pool } = pg;

const HOST = process.env.PGHOST!;
const REGION = process.env.AWS_REGION ?? "us-east-1";
const S = "compass_prod";

const signer = new DsqlSigner({
  credentials: awsCredentialsProvider({
    roleArn: process.env.AWS_ROLE_ARN!,
    clientConfig: { region: REGION },
  }),
  hostname: HOST,
  region: REGION,
  expiresIn: 900,
});

const pool = new Pool({
  host: HOST,
  user: process.env.PGUSER ?? "admin",
  database: process.env.PGDATABASE ?? "postgres",
  password: () => signer.getDbConnectAdminAuthToken(),
  port: 5432,
  ssl: true,
  max: 1,
});

async function q(sql: string, params: unknown[] = []) {
  const { rows } = await pool.query(sql, params);
  return rows;
}
async function one(sql: string, params: unknown[] = []) {
  const rows = await q(sql, params);
  return rows[0];
}

async function main() {
  console.log("Connecting to", HOST);

  const user = await one(`SELECT id, email FROM "${S}".users WHERE email = $1`, ["rick@rbcodelabs.com"]);
  if (!user) throw new Error("User not found");
  console.log("User:", user.email, user.id);

  // 1. Rename org slug from rb-code-labs to rbcodelabs
  const org = await one(`SELECT id, slug FROM "${S}".organizations WHERE slug = $1`, ["rb-code-labs"]);
  if (!org) throw new Error("Org rb-code-labs not found");

  await q(`UPDATE "${S}".organizations SET slug = 'rbcodelabs', name = 'RB Code Labs' WHERE id = $1`, [org.id]);
  console.log("✅ Org slug updated: rb-code-labs → rbcodelabs");

  // 2. Create compass workspace (idempotent)
  let ws = await one(`SELECT id FROM "${S}".workspaces WHERE organization_id = $1 AND slug = 'compass'`, [org.id]);
  if (!ws) {
    ws = await one(
      `INSERT INTO "${S}".workspaces (organization_id, name, slug) VALUES ($1, 'Compass', 'compass') RETURNING id`,
      [org.id]
    );
    console.log("✅ Workspace 'compass' created:", ws.id);
  } else {
    console.log("ℹ️  Workspace 'compass' already exists:", ws.id);
  }

  // 3. Add user as member (idempotent)
  const existing = await one(
    `SELECT id FROM "${S}".workspace_members WHERE workspace_id = $1 AND user_id = $2`,
    [ws.id, user.id]
  );
  if (!existing) {
    await q(
      `INSERT INTO "${S}".workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [ws.id, user.id]
    );
    console.log("✅ Added user as owner of compass workspace");
  } else {
    console.log("ℹ️  User already member");
  }

  // 4. Create API key for MCP access
  const apiKey = crypto.randomBytes(32).toString("hex");
  const keyHash = crypto.createHash("sha256").update(apiKey).digest("hex");
  const existingKey = await one(`SELECT id FROM "${S}".api_keys WHERE user_id = $1 AND workspace_id = $2`, [user.id, ws.id]);
  if (!existingKey) {
    await q(
      `INSERT INTO "${S}".api_keys (user_id, workspace_id, key_hash, label) VALUES ($1, $2, $3, $4)`,
      [user.id, ws.id, keyHash, "MCP — Compass meta workspace"]
    );
    console.log("\n🔑 API Key (save this — only shown once):");
    console.log(apiKey);
  } else {
    console.log("ℹ️  API key already exists for this workspace (use Settings → API Access to regenerate if needed)");
  }

  console.log("\n✅ Done! Workspace URL: https://compass-ruby-theta.vercel.app/rbcodelabs/compass/okrs");
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
