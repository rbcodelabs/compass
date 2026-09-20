import type { PoolClient } from "pg"

/**
 * Postcondition assertion for migration 055_oauth_authorization_server.
 *
 * Mirrors assertSharedFieldOptionSetsMigration / assertAgentIdentityMigration:
 * the runner only writes a finished receipt once this passes, so a
 * half-created catalog stays visible as an unfinished attempt rather than being
 * recorded as done. That matters more than usual here because every index in
 * this migration is created ASYNC — a wait that times out leaves an index
 * `indisvalid = false`, and an authorization server whose `oauth_tokens` unique
 * hash index is not yet valid would happily mint duplicate token rows.
 *
 * All four tables are new, so the assertion is a straight completeness check:
 * every declared column present, every declared index present and valid.
 */

export const OAUTH_AUTHORIZATION_SERVER_TABLES = [
  "oauth_clients",
  "oauth_authorization_codes",
  "oauth_tokens",
  "oauth_consents",
] as const

export const OAUTH_AUTHORIZATION_SERVER_INDEXES = [
  "idx_oauth_clients_client_id",
  "idx_oauth_clients_last_used",
  "idx_oauth_authorization_codes_hash",
  "idx_oauth_authorization_codes_expires",
  "idx_oauth_tokens_hash",
  "idx_oauth_tokens_family",
  "idx_oauth_tokens_user_client",
  "idx_oauth_tokens_expires",
  "idx_oauth_consents_user_client",
] as const

export const OAUTH_AUTHORIZATION_SERVER_COLUMNS = [
  "oauth_clients.id",
  "oauth_clients.client_id",
  "oauth_clients.client_secret_hash",
  "oauth_clients.client_name",
  "oauth_clients.redirect_uris",
  "oauth_clients.grant_types",
  "oauth_clients.scope",
  "oauth_clients.token_endpoint_auth_method",
  "oauth_clients.logo_uri",
  "oauth_clients.client_uri",
  "oauth_clients.software_id",
  "oauth_clients.registration_access_token_hash",
  "oauth_clients.created_at",
  "oauth_clients.last_used_at",
  "oauth_authorization_codes.id",
  "oauth_authorization_codes.code_hash",
  "oauth_authorization_codes.client_id",
  "oauth_authorization_codes.user_id",
  "oauth_authorization_codes.redirect_uri",
  "oauth_authorization_codes.code_challenge",
  "oauth_authorization_codes.code_challenge_method",
  "oauth_authorization_codes.scope",
  "oauth_authorization_codes.resource",
  "oauth_authorization_codes.expires_at",
  "oauth_authorization_codes.consumed_at",
  "oauth_authorization_codes.created_at",
  "oauth_tokens.id",
  "oauth_tokens.token_hash",
  "oauth_tokens.type",
  "oauth_tokens.client_id",
  "oauth_tokens.user_id",
  "oauth_tokens.scope",
  "oauth_tokens.resource",
  "oauth_tokens.scope_workspace_id",
  "oauth_tokens.expires_at",
  "oauth_tokens.revoked_at",
  "oauth_tokens.family_id",
  "oauth_tokens.parent_token_id",
  "oauth_tokens.created_at",
  "oauth_tokens.last_used_at",
  "oauth_consents.id",
  "oauth_consents.user_id",
  "oauth_consents.client_id",
  "oauth_consents.scope",
  "oauth_consents.granted_at",
] as const

/**
 * Columns that must stay nullable. Each one records a lifecycle event that has
 * not happened yet — a token that was never revoked, a code that was never
 * consumed, a client that has never been used. A NOT NULL here would force the
 * issuing path to invent a sentinel value and quietly break the "is this still
 * live?" predicates that every lookup depends on.
 */
const NULLABLE_COLUMNS = [
  "oauth_clients.client_secret_hash",
  "oauth_clients.last_used_at",
  "oauth_authorization_codes.consumed_at",
  "oauth_tokens.revoked_at",
  "oauth_tokens.scope_workspace_id",
  "oauth_tokens.parent_token_id",
  "oauth_tokens.last_used_at",
] as const

/** Indexes whose uniqueness is a correctness constraint, not an optimization. */
const UNIQUE_INDEXES = [
  "idx_oauth_clients_client_id",
  "idx_oauth_authorization_codes_hash",
  "idx_oauth_tokens_hash",
  "idx_oauth_consents_user_client",
] as const

type ColumnRow = {
  table_name: string
  column_name: string
  is_nullable: string
}

type IndexRow = {
  name: string
  valid: boolean
  unique: boolean
}

export async function assertOAuthAuthorizationServerMigration(client: PoolClient, schema: string) {
  const columns = await client.query<ColumnRow>(
    "SELECT table_name, column_name, is_nullable FROM information_schema.columns WHERE table_schema=$1 AND table_name = ANY($2::text[])",
    [schema, [...OAUTH_AUTHORIZATION_SERVER_TABLES]],
  )
  const byName = new Map(columns.rows.map((row) => [`${row.table_name}.${row.column_name}`, row]))

  const missing = OAUTH_AUTHORIZATION_SERVER_COLUMNS.filter((column) => !byName.has(column))
  if (missing.length > 0) {
    throw new Error(`Migration 055 postcondition failed: missing column(s) ${missing.join(", ")}.`)
  }

  const wronglyRequired = NULLABLE_COLUMNS.filter((column) => byName.get(column)!.is_nullable !== "YES")
  if (wronglyRequired.length > 0) {
    throw new Error(
      `Migration 055 postcondition failed: column(s) must be nullable: ${wronglyRequired.join(", ")}.`,
    )
  }

  const indexes = await client.query<IndexRow>(
    "SELECT c.relname AS name, i.indisvalid AS valid, i.indisunique AS unique FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname = ANY($2::text[])",
    [schema, [...OAUTH_AUTHORIZATION_SERVER_INDEXES]],
  )
  const unhealthy = OAUTH_AUTHORIZATION_SERVER_INDEXES.filter(
    (name) => !indexes.rows.some((row) => row.name === name && row.valid),
  )
  if (unhealthy.length > 0) {
    throw new Error(
      `Migration 055 postcondition failed: index(es) missing or not valid: ${unhealthy.join(", ")}.`,
    )
  }

  // An ASYNC index that came back valid but not unique would let the token
  // endpoint mint two rows for one hash, which no downstream lookup can detect.
  const notUnique = UNIQUE_INDEXES.filter(
    (name) => !indexes.rows.some((row) => row.name === name && row.unique),
  )
  if (notUnique.length > 0) {
    throw new Error(
      `Migration 055 postcondition failed: index(es) must be UNIQUE: ${notUnique.join(", ")}.`,
    )
  }
}
