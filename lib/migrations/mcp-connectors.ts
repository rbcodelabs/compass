/**
 * Postconditions for 062_mcp_connectors (ADR-0018).
 *
 * All three unique indexes here are correctness, not performance, so uniqueness
 * is asserted explicitly rather than inferred from the DDL having executed:
 *
 *   - `idx_mcp_connectors_slug_origin` is what makes lazy per-origin Dynamic
 *     Client Registration safe. Two concurrent first-connects from the same
 *     preview URL race to register with the provider; the loser's insert must
 *     collide. Without uniqueness both succeed, and the origin ends up with two
 *     client registrations — the second silently orphaning the first.
 *   - `idx_mcp_connector_auth_requests_state` is what makes the callback's
 *     conditional updateMany a genuine single-use consume. Two rows sharing a
 *     `state` could each be consumed once, which is an authorization-code replay.
 *   - `idx_mcp_connector_grants_connector_user` enforces one grant per user per
 *     connector. Duplicates would refresh against each other, and the
 *     generation compare-and-swap only serialises writers to the *same* row.
 *
 * A merely *ready* index would not enforce any of that, so `indisunique` is
 * checked alongside `indisvalid`/`indisready`.
 */

import type { PoolClient } from "pg"

export const MCP_CONNECTOR_TABLES = ["mcp_connectors", "mcp_connector_grants", "mcp_connector_auth_requests"]
export const MCP_CONNECTOR_UNIQUE_INDEXES = [
  "idx_mcp_connectors_slug_origin",
  "idx_mcp_connector_auth_requests_state",
  "idx_mcp_connector_grants_connector_user",
]
export const MCP_CONNECTOR_INDEXES = [
  ...MCP_CONNECTOR_UNIQUE_INDEXES,
  "idx_mcp_connector_grants_user",
  "idx_mcp_connector_auth_requests_expires",
]

export async function assertMcpConnectorsMigration(client: PoolClient, schema: string) {
  const expectedColumns = [
    { name: "mcp_connectors.id", nullable: false },
    { name: "mcp_connectors.slug", nullable: false },
    { name: "mcp_connectors.origin", nullable: false },
    { name: "mcp_connectors.display_name", nullable: false },
    { name: "mcp_connectors.server_url", nullable: false },
    { name: "mcp_connectors.resource", nullable: false },
    { name: "mcp_connectors.authorization_endpoint", nullable: false },
    { name: "mcp_connectors.token_endpoint", nullable: false },
    { name: "mcp_connectors.revocation_endpoint", nullable: true },
    { name: "mcp_connectors.scope", nullable: false },
    { name: "mcp_connectors.client_id", nullable: false },
    { name: "mcp_connectors.enabled", nullable: false },
    { name: "mcp_connectors.created_at", nullable: false },
    { name: "mcp_connectors.updated_at", nullable: false },
    { name: "mcp_connector_grants.id", nullable: false },
    { name: "mcp_connector_grants.connector_id", nullable: false },
    { name: "mcp_connector_grants.user_id", nullable: false },
    { name: "mcp_connector_grants.access_token_encrypted", nullable: false },
    // Nullable on purpose: a provider that issues no refresh token yields a
    // grant that simply expires and is reconnected, rather than one that fails
    // opaquely mid-run.
    { name: "mcp_connector_grants.refresh_token_encrypted", nullable: true },
    { name: "mcp_connector_grants.access_token_expires_at", nullable: true },
    { name: "mcp_connector_grants.scope", nullable: false },
    { name: "mcp_connector_grants.status", nullable: false },
    { name: "mcp_connector_grants.generation", nullable: false },
    { name: "mcp_connector_grants.created_at", nullable: false },
    { name: "mcp_connector_grants.updated_at", nullable: false },
    { name: "mcp_connector_auth_requests.id", nullable: false },
    { name: "mcp_connector_auth_requests.state", nullable: false },
    { name: "mcp_connector_auth_requests.connector_id", nullable: false },
    { name: "mcp_connector_auth_requests.user_id", nullable: false },
    { name: "mcp_connector_auth_requests.code_verifier", nullable: false },
    { name: "mcp_connector_auth_requests.redirect_uri", nullable: false },
    { name: "mcp_connector_auth_requests.return_to", nullable: true },
    { name: "mcp_connector_auth_requests.expires_at", nullable: false },
    { name: "mcp_connector_auth_requests.consumed_at", nullable: true },
    { name: "mcp_connector_auth_requests.created_at", nullable: false },
  ]

  const tables = await client.query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name = ANY($2::text[])",
    [schema, MCP_CONNECTOR_TABLES]
  )
  if (MCP_CONNECTOR_TABLES.some(name => !tables.rows.some(row => row.table_name === name)))
    throw new Error("062_mcp_connectors: missing tables")

  const columns = await client.query<{ table_name: string; column_name: string; is_nullable: string }>(
    "SELECT table_name, column_name, is_nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name = ANY($2::text[])",
    [schema, MCP_CONNECTOR_TABLES]
  )
  for (const expected of expectedColumns) {
    const actual = columns.rows.find(row => `${row.table_name}.${row.column_name}` === expected.name)
    if (!actual || (actual.is_nullable === "YES") !== expected.nullable)
      throw new Error(`062_mcp_connectors: column postcondition failed: ${expected.name}`)
  }

  const indexes = await client.query<{ name: string; valid: boolean; ready: boolean; unique: boolean }>(
    `SELECT c.relname AS name, i.indisvalid AS valid, i.indisready AS ready, i.indisunique AS unique
     FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relname = ANY($2::text[])`,
    [schema, MCP_CONNECTOR_INDEXES]
  )
  for (const name of MCP_CONNECTOR_INDEXES) {
    const index = indexes.rows.find(row => row.name === name)
    if (!index || !index.valid || !index.ready)
      throw new Error(`062_mcp_connectors: index ${name} is missing or unfinished`)
  }
  for (const name of MCP_CONNECTOR_UNIQUE_INDEXES) {
    if (!indexes.rows.find(row => row.name === name)?.unique)
      throw new Error(`062_mcp_connectors: index ${name} is not unique; per-origin registration and single-use state would not hold`)
  }
}
