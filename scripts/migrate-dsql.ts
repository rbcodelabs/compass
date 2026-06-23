#!/usr/bin/env node
/**
 * Push the Compass schema to Aurora DSQL.
 * Usage: node --env-file=.env.local scripts/migrate-dsql.ts [schema_name]
 * Default schema: compass_dev
 */
import { Pool } from "pg";
import { DsqlSigner } from "@aws-sdk/dsql-signer";
import { awsCredentialsProvider } from "@vercel/functions/oidc";

const host = process.env.PGHOST;
if (!host) throw new Error("PGHOST is required");

const schemaArg = process.argv[2];
const schemaPrefix = process.env.PGSCHEMA ?? "compass";
const schema = schemaArg ?? `${schemaPrefix}_dev`;

console.log(`Migrating schema: ${schema} on ${host}`);

const signer = new DsqlSigner({
  credentials: awsCredentialsProvider({
    roleArn: process.env.AWS_ROLE_ARN!,
    clientConfig: { region: process.env.AWS_REGION },
  }),
  hostname: host,
  region: process.env.AWS_REGION ?? "us-east-1",
  expiresIn: 900,
});

const password = await signer.getDbConnectAdminAuthToken();

const pool = new Pool({
  host,
  user: process.env.PGUSER ?? "admin",
  database: process.env.PGDATABASE ?? "postgres",
  password,
  port: 5432,
  ssl: true,
});

const client = await pool.connect();

try {
  // Create schema
  await client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
  await client.query(`SET search_path TO "${schema}"`);

  console.log("Creating tables...");
  const tables = [
    // Auth
    `CREATE TABLE IF NOT EXISTS "${schema}"."users" (
      "id" UUID NOT NULL DEFAULT gen_random_uuid(),
      "name" VARCHAR(255),
      "email" VARCHAR(255) NOT NULL,
      "email_verified" TIMESTAMP(3),
      "image" TEXT,
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "users_pkey" PRIMARY KEY ("id")
    )`,
    `CREATE UNIQUE INDEX ASYNC IF NOT EXISTS "users_email_key" ON "${schema}"."users"("email")`,

    `CREATE TABLE IF NOT EXISTS "${schema}"."accounts" (
      "user_id" UUID NOT NULL,
      "type" VARCHAR(50) NOT NULL,
      "provider" VARCHAR(100) NOT NULL,
      "provider_account_id" VARCHAR(255) NOT NULL,
      "refresh_token" TEXT,
      "access_token" TEXT,
      "expires_at" INTEGER,
      "token_type" VARCHAR(50),
      "scope" TEXT,
      "id_token" TEXT,
      "session_state" VARCHAR(255),
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "accounts_pkey" PRIMARY KEY ("provider","provider_account_id")
    )`,

    `CREATE TABLE IF NOT EXISTS "${schema}"."sessions" (
      "id" UUID NOT NULL DEFAULT gen_random_uuid(),
      "session_token" VARCHAR(512) NOT NULL,
      "user_id" UUID NOT NULL,
      "expires" TIMESTAMP(3) NOT NULL,
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
    )`,
    `CREATE UNIQUE INDEX ASYNC IF NOT EXISTS "sessions_session_token_key" ON "${schema}"."sessions"("session_token")`,

    `CREATE TABLE IF NOT EXISTS "${schema}"."verification_tokens" (
      "identifier" VARCHAR(255) NOT NULL,
      "token" VARCHAR(512) NOT NULL,
      "expires" TIMESTAMP(3) NOT NULL,
      CONSTRAINT "verification_tokens_pkey" PRIMARY KEY ("identifier","token")
    )`,

    // Multi-tenancy
    `CREATE TABLE IF NOT EXISTS "${schema}"."organizations" (
      "id" UUID NOT NULL DEFAULT gen_random_uuid(),
      "slug" VARCHAR(255) NOT NULL,
      "name" VARCHAR(255) NOT NULL,
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
    )`,
    `CREATE UNIQUE INDEX ASYNC IF NOT EXISTS "organizations_slug_key" ON "${schema}"."organizations"("slug")`,

    `CREATE TABLE IF NOT EXISTS "${schema}"."organization_members" (
      "id" UUID NOT NULL DEFAULT gen_random_uuid(),
      "organization_id" UUID NOT NULL,
      "user_id" UUID NOT NULL,
      "role" VARCHAR(50) NOT NULL DEFAULT 'MEMBER',
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "organization_members_pkey" PRIMARY KEY ("id")
    )`,
    `CREATE UNIQUE INDEX ASYNC IF NOT EXISTS "organization_members_org_user" ON "${schema}"."organization_members"("organization_id","user_id")`,

    `CREATE TABLE IF NOT EXISTS "${schema}"."workspaces" (
      "id" UUID NOT NULL DEFAULT gen_random_uuid(),
      "organization_id" UUID NOT NULL,
      "slug" VARCHAR(255) NOT NULL,
      "name" VARCHAR(255) NOT NULL,
      "description" TEXT,
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "workspaces_pkey" PRIMARY KEY ("id")
    )`,
    `CREATE UNIQUE INDEX ASYNC IF NOT EXISTS "workspaces_org_slug" ON "${schema}"."workspaces"("organization_id","slug")`,

    `CREATE TABLE IF NOT EXISTS "${schema}"."workspace_members" (
      "id" UUID NOT NULL DEFAULT gen_random_uuid(),
      "workspace_id" UUID NOT NULL,
      "user_id" UUID NOT NULL,
      "role" VARCHAR(50) NOT NULL DEFAULT 'MEMBER',
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "workspace_members_pkey" PRIMARY KEY ("id")
    )`,
    `CREATE UNIQUE INDEX ASYNC IF NOT EXISTS "workspace_members_ws_user" ON "${schema}"."workspace_members"("workspace_id","user_id")`,

    // OKRs
    `CREATE TABLE IF NOT EXISTS "${schema}"."okr_cycles" (
      "id" UUID NOT NULL DEFAULT gen_random_uuid(),
      "workspace_id" UUID NOT NULL,
      "title" VARCHAR(255) NOT NULL,
      "start_date" TIMESTAMP(3) NOT NULL,
      "end_date" TIMESTAMP(3) NOT NULL,
      "status" VARCHAR(50) NOT NULL DEFAULT 'DRAFT',
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "okr_cycles_pkey" PRIMARY KEY ("id")
    )`,

    `CREATE TABLE IF NOT EXISTS "${schema}"."objectives" (
      "id" UUID NOT NULL DEFAULT gen_random_uuid(),
      "cycle_id" UUID NOT NULL,
      "title" VARCHAR(255) NOT NULL,
      "description" TEXT,
      "owner" VARCHAR(255),
      "status" VARCHAR(50) NOT NULL DEFAULT 'ON_TRACK',
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "objectives_pkey" PRIMARY KEY ("id")
    )`,

    `CREATE TABLE IF NOT EXISTS "${schema}"."key_results" (
      "id" UUID NOT NULL DEFAULT gen_random_uuid(),
      "objective_id" UUID NOT NULL,
      "title" VARCHAR(255) NOT NULL,
      "target" DOUBLE PRECISION NOT NULL,
      "current" DOUBLE PRECISION NOT NULL DEFAULT 0,
      "unit" VARCHAR(255),
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "key_results_pkey" PRIMARY KEY ("id")
    )`,

    `CREATE TABLE IF NOT EXISTS "${schema}"."check_ins" (
      "id" UUID NOT NULL DEFAULT gen_random_uuid(),
      "key_result_id" UUID NOT NULL,
      "value" DOUBLE PRECISION NOT NULL,
      "note" TEXT,
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "check_ins_pkey" PRIMARY KEY ("id")
    )`,

    // Discovery
    `CREATE TABLE IF NOT EXISTS "${schema}"."opportunities" (
      "id" UUID NOT NULL DEFAULT gen_random_uuid(),
      "workspace_id" UUID NOT NULL,
      "title" VARCHAR(255) NOT NULL,
      "description" TEXT,
      "customer_segment" VARCHAR(255),
      "status" VARCHAR(50) NOT NULL DEFAULT 'EXPLORING',
      "linked_key_result_id" UUID,
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "opportunities_pkey" PRIMARY KEY ("id")
    )`,

    `CREATE TABLE IF NOT EXISTS "${schema}"."solutions" (
      "id" UUID NOT NULL DEFAULT gen_random_uuid(),
      "opportunity_id" UUID NOT NULL,
      "title" VARCHAR(255) NOT NULL,
      "description" TEXT,
      "status" VARCHAR(50) NOT NULL DEFAULT 'IDEA',
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "solutions_pkey" PRIMARY KEY ("id")
    )`,

    `CREATE TABLE IF NOT EXISTS "${schema}"."assumptions" (
      "id" UUID NOT NULL DEFAULT gen_random_uuid(),
      "solution_id" UUID NOT NULL,
      "title" VARCHAR(255) NOT NULL,
      "risk_level" VARCHAR(50) NOT NULL DEFAULT 'MEDIUM',
      "status" VARCHAR(50) NOT NULL DEFAULT 'UNTESTED',
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "assumptions_pkey" PRIMARY KEY ("id")
    )`,

    // Experiments
    `CREATE TABLE IF NOT EXISTS "${schema}"."experiments" (
      "id" UUID NOT NULL DEFAULT gen_random_uuid(),
      "workspace_id" UUID NOT NULL,
      "assumption_id" UUID,
      "title" VARCHAR(255) NOT NULL,
      "hypothesis" TEXT NOT NULL,
      "method" TEXT NOT NULL,
      "kill_condition" TEXT NOT NULL,
      "status" VARCHAR(50) NOT NULL DEFAULT 'DESIGNING',
      "start_date" TIMESTAMP(3),
      "end_date" TIMESTAMP(3),
      "conclusion" VARCHAR(50),
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "experiments_pkey" PRIMARY KEY ("id")
    )`,

    `CREATE TABLE IF NOT EXISTS "${schema}"."experiment_results" (
      "id" UUID NOT NULL DEFAULT gen_random_uuid(),
      "experiment_id" UUID NOT NULL,
      "note" TEXT NOT NULL,
      "metric" VARCHAR(255),
      "value" DOUBLE PRECISION,
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "experiment_results_pkey" PRIMARY KEY ("id")
    )`,

    // Roadmap
    `CREATE TABLE IF NOT EXISTS "${schema}"."roadmap_items" (
      "id" UUID NOT NULL DEFAULT gen_random_uuid(),
      "workspace_id" UUID NOT NULL,
      "title" VARCHAR(255) NOT NULL,
      "description" TEXT,
      "horizon" VARCHAR(50) NOT NULL DEFAULT 'NOW',
      "status" VARCHAR(50) NOT NULL DEFAULT 'ACTIVE',
      "sort_order" INTEGER NOT NULL DEFAULT 0,
      "solution_id" UUID,
      "key_result_id" UUID,
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "roadmap_items_pkey" PRIMARY KEY ("id")
    )`,
  ];

  for (const sql of tables) {
    try {
      await client.query(sql);
      const name = sql.match(/"([^"]+)"\s*\(/)?.[1] ?? "index";
      console.log(`  ✓ ${name}`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("already exists")) {
        console.log(`  ~ already exists`);
      } else {
        throw e;
      }
    }
  }

  console.log(`\n✅ Schema "${schema}" is ready.`);
} finally {
  client.release();
  await pool.end();
}
