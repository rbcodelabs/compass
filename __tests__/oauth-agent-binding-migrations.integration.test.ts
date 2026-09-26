import { randomUUID } from "node:crypto"

import { Pool } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { applyMigrations } from "@/lib/migrations/runner"

/**
 * Exercises the complete agent-scoped OAuth migration sequence against a real
 * PostgreSQL schema owned by this test. Opt in with
 * AGENT_SCOPED_OAUTH_MIGRATIONS_DATABASE_URL pointing at the local
 * compass_e2e database. Skipped by default so the normal suite stays hermetic.
 */
const databaseUrl = process.env.AGENT_SCOPED_OAUTH_MIGRATIONS_DATABASE_URL

describe.skipIf(!databaseUrl)("056-058 OAuth migrations on an owned local schema", () => {
  const schema = `oauth_agent_binding_${randomUUID().replaceAll("-", "")}`
  const pool = new Pool({ connectionString: databaseUrl, max: 2 })
  const previous = process.env.DATABASE_URL
  let created = false

  const legacyUserId = randomUUID()
  const legacyCodeId = randomUUID()
  const legacyTokenId = randomUUID()
  const legacyConsentId = randomUUID()
  const legacyToolCallId = randomUUID()

  beforeAll(async () => {
    const url = new URL(databaseUrl!)
    if (
      url.protocol !== "postgresql:" ||
      !["localhost", "127.0.0.1"].includes(url.hostname) ||
      url.pathname !== "/compass_e2e" ||
      url.searchParams.has("schema")
    ) {
      throw new Error("Requires local compass_e2e without schema override")
    }

    // DATABASE_URL is the runner's local-mode signal: it rewrites DSQL's
    // INDEX ASYNC syntax to PostgreSQL's synchronous INDEX syntax.
    process.env.DATABASE_URL = databaseUrl
    await pool.query(`CREATE SCHEMA "${schema}"`)
    created = true

    await pool.query(`CREATE TABLE "${schema}".oauth_authorization_codes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      code_hash VARCHAR(64) NOT NULL,
      client_id VARCHAR(64) NOT NULL,
      user_id UUID NOT NULL,
      redirect_uri TEXT NOT NULL,
      code_challenge VARCHAR(128) NOT NULL,
      code_challenge_method VARCHAR(10) NOT NULL,
      scope VARCHAR(255) NOT NULL,
      resource TEXT NOT NULL,
      expires_at TIMESTAMP NOT NULL,
      consumed_at TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`)
    await pool.query(`CREATE TABLE "${schema}".oauth_tokens (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      token_hash VARCHAR(64) NOT NULL,
      type VARCHAR(10) NOT NULL,
      client_id VARCHAR(64) NOT NULL,
      user_id UUID NOT NULL,
      scope VARCHAR(255) NOT NULL,
      resource TEXT NOT NULL,
      scope_workspace_id UUID,
      expires_at TIMESTAMP NOT NULL,
      revoked_at TIMESTAMP,
      family_id UUID NOT NULL,
      parent_token_id UUID,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_used_at TIMESTAMP
    )`)
    await pool.query(`CREATE TABLE "${schema}".oauth_consents (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL,
      client_id VARCHAR(64) NOT NULL,
      scope VARCHAR(255) NOT NULL,
      granted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`)
    await pool.query(`CREATE TABLE "${schema}".agent_tool_calls (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      agent_id UUID NOT NULL,
      user_id UUID NOT NULL,
      credential_id UUID NOT NULL,
      tool_name VARCHAR(100) NOT NULL,
      workspace_id UUID,
      status VARCHAR(20) NOT NULL DEFAULT 'STARTED',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      finished_at TIMESTAMP
    )`)

    await pool.query(
      `INSERT INTO "${schema}".oauth_authorization_codes
        (id, code_hash, client_id, user_id, redirect_uri, code_challenge,
         code_challenge_method, scope, resource, expires_at)
       VALUES ($1, $2, 'legacy-client', $3, 'http://127.0.0.1/callback',
         'challenge', 'S256', 'mcp:tools', 'https://compass.example/mcp', now() + interval '1 hour')`,
      [legacyCodeId, "c".repeat(64), legacyUserId],
    )
    await pool.query(
      `INSERT INTO "${schema}".oauth_tokens
        (id, token_hash, type, client_id, user_id, scope, resource, expires_at, family_id)
       VALUES ($1, $2, 'ACCESS', 'legacy-client', $3, 'mcp:tools',
         'https://compass.example/mcp', now() + interval '1 hour', gen_random_uuid())`,
      [legacyTokenId, "t".repeat(64), legacyUserId],
    )
    await pool.query(
      `INSERT INTO "${schema}".oauth_consents (id, user_id, client_id, scope)
       VALUES ($1, $2, 'legacy-client', 'mcp:tools')`,
      [legacyConsentId, legacyUserId],
    )
    await pool.query(
      `INSERT INTO "${schema}".agent_tool_calls
        (id, agent_id, user_id, credential_id, tool_name)
       VALUES ($1, gen_random_uuid(), $2, gen_random_uuid(), 'get_current_identity')`,
      [legacyToolCallId, legacyUserId],
    )
  })

  afterAll(async () => {
    try {
      if (created) await pool.query(`DROP SCHEMA "${schema}" CASCADE`)
    } finally {
      await pool.end()
      if (previous === undefined) delete process.env.DATABASE_URL
      else process.env.DATABASE_URL = previous
    }
  })

  it("backfills binding columns, forces re-consent, and creates durable authorization events", async () => {
    const migration056 = "056_agent_scoped_oauth_binding"
    const response056 = await applyMigrations(pool, schema, migration056)
    const body056 = await response056.json()
    expect(body056, JSON.stringify(body056)).not.toHaveProperty("error")
    expect(response056.status).toBe(200)

    const columns056 = await pool.query(
      `SELECT table_name, column_name, is_nullable
       FROM information_schema.columns
       WHERE table_schema=$1 AND (
         (table_name='oauth_authorization_codes' AND column_name IN ('authorization_mode','agent_id')) OR
         (table_name='oauth_tokens' AND column_name IN ('authorization_mode','agent_id')) OR
         (table_name='oauth_consents' AND column_name IN ('authorization_mode','agent_id')) OR
         (table_name='agent_tool_calls' AND column_name='credential_type')
       ) ORDER BY table_name, column_name`,
      [schema],
    )
    expect(columns056.rows).toEqual([
      { table_name: "agent_tool_calls", column_name: "credential_type", is_nullable: "YES" },
      { table_name: "oauth_authorization_codes", column_name: "agent_id", is_nullable: "YES" },
      { table_name: "oauth_authorization_codes", column_name: "authorization_mode", is_nullable: "YES" },
      { table_name: "oauth_consents", column_name: "agent_id", is_nullable: "YES" },
      { table_name: "oauth_consents", column_name: "authorization_mode", is_nullable: "YES" },
      { table_name: "oauth_tokens", column_name: "agent_id", is_nullable: "YES" },
      { table_name: "oauth_tokens", column_name: "authorization_mode", is_nullable: "YES" },
    ])

    const backfilled = await pool.query(
      `SELECT
        (SELECT authorization_mode FROM "${schema}".oauth_authorization_codes WHERE id=$1) AS code_mode,
        (SELECT authorization_mode FROM "${schema}".oauth_tokens WHERE id=$2) AS token_mode,
        (SELECT authorization_mode FROM "${schema}".oauth_consents WHERE id=$3) AS consent_mode,
        (SELECT credential_type FROM "${schema}".agent_tool_calls WHERE id=$4) AS credential_type`,
      [legacyCodeId, legacyTokenId, legacyConsentId, legacyToolCallId],
    )
    expect(backfilled.rows).toEqual([
      { code_mode: "USER", token_mode: "USER", consent_mode: "USER", credential_type: "API_KEY" },
    ])

    const agentIndex = await pool.query(
      `SELECT i.indisunique, i.indisvalid
       FROM pg_index i
       JOIN pg_class c ON c.oid=i.indexrelid
       JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname=$1 AND c.relname='idx_oauth_tokens_agent'`,
      [schema],
    )
    expect(agentIndex.rows).toEqual([{ indisunique: false, indisvalid: true }])

    const migration057 = "057_oauth_forced_reconsent"
    const response057 = await applyMigrations(pool, schema, migration057)
    const body057 = await response057.json()
    expect(body057, JSON.stringify(body057)).not.toHaveProperty("error")
    expect(response057.status).toBe(200)
    expect(
      await pool.query(`SELECT revoked_at IS NOT NULL AS revoked FROM "${schema}".oauth_tokens WHERE id=$1`, [legacyTokenId]),
    ).toMatchObject({ rows: [{ revoked: true }] })
    expect(
      await pool.query(
        `SELECT
          (SELECT count(*)::int FROM "${schema}".oauth_authorization_codes) AS codes,
          (SELECT count(*)::int FROM "${schema}".oauth_consents) AS consents`,
      ),
    ).toMatchObject({ rows: [{ codes: 0, consents: 0 }] })

    const migration058 = "058_oauth_authorization_events"
    const response058 = await applyMigrations(pool, schema, migration058)
    const body058 = await response058.json()
    expect(body058, JSON.stringify(body058)).not.toHaveProperty("error")
    expect(response058.status).toBe(200)

    const eventColumns = await pool.query(
      `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
       WHERE table_schema=$1 AND table_name='oauth_authorization_events'
       ORDER BY ordinal_position`,
      [schema],
    )
    expect(eventColumns.rows).toEqual([
      { column_name: "id", data_type: "uuid", is_nullable: "NO" },
      { column_name: "event_type", data_type: "character varying", is_nullable: "NO" },
      { column_name: "source", data_type: "character varying", is_nullable: "NO" },
      { column_name: "authorization_code_id", data_type: "uuid", is_nullable: "NO" },
      { column_name: "user_id", data_type: "uuid", is_nullable: "NO" },
      { column_name: "client_id", data_type: "character varying", is_nullable: "NO" },
      { column_name: "client_name_snapshot", data_type: "character varying", is_nullable: "NO" },
      { column_name: "redirect_origin", data_type: "text", is_nullable: "NO" },
      { column_name: "authorization_mode", data_type: "character varying", is_nullable: "NO" },
      { column_name: "agent_id", data_type: "uuid", is_nullable: "YES" },
      { column_name: "scope", data_type: "character varying", is_nullable: "NO" },
      { column_name: "created_at", data_type: "timestamp without time zone", is_nullable: "NO" },
    ])

    const eventIndexes = await pool.query(
      `SELECT c.relname AS name, i.indisunique, i.indisvalid
       FROM pg_index i
       JOIN pg_class c ON c.oid=i.indexrelid
       JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname=$1 AND c.relname = ANY($2::text[])
       ORDER BY c.relname`,
      [schema, [
        "idx_oauth_authorization_events_code",
        "idx_oauth_authorization_events_user_created",
        "idx_oauth_authorization_events_client_created",
      ]],
    )
    expect(eventIndexes.rows).toEqual([
      { name: "idx_oauth_authorization_events_client_created", indisunique: false, indisvalid: true },
      { name: "idx_oauth_authorization_events_code", indisunique: true, indisvalid: true },
      { name: "idx_oauth_authorization_events_user_created", indisunique: false, indisvalid: true },
    ])

    const authorizationCodeId = randomUUID()
    const insertEvent = () => pool.query(
      `INSERT INTO "${schema}".oauth_authorization_events
        (event_type, source, authorization_code_id, user_id, client_id,
         client_name_snapshot, redirect_origin, authorization_mode, agent_id, scope)
       VALUES ('AUTHORIZED', 'CONSENT', $1, $2, 'agent-threads',
         'Agent Threads', 'http://127.0.0.1', 'USER', NULL, 'mcp:tools')`,
      [authorizationCodeId, legacyUserId],
    )
    await expect(insertEvent()).resolves.toBeTruthy()
    await expect(insertEvent()).rejects.toThrow(/duplicate key/i)

    for (const migration of [migration056, migration057, migration058]) {
      const replay = await applyMigrations(pool, schema, migration)
      expect(replay.status).toBe(200)
    }
    const receipts = await pool.query(
      `SELECT migration_name, count(*)::int AS count
       FROM "${schema}"._prisma_migrations
       WHERE migration_name = ANY($1::text[]) AND finished_at IS NOT NULL
       GROUP BY migration_name ORDER BY migration_name`,
      [[migration056, migration057, migration058]],
    )
    expect(receipts.rows).toEqual([
      { migration_name: migration056, count: 1 },
      { migration_name: migration057, count: 1 },
      { migration_name: migration058, count: 1 },
    ])
  }, 30_000)
})
