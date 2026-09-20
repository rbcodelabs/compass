import type { PoolClient } from "pg"

/**
 * Migration 057 deliberately invalidates every existing OAuth authorization.
 * Keep its receipt unfinished unless both bypasses around the new consent
 * screen are gone: live tokens, remembered database consent, and authorization
 * codes that could mint a fresh family after the migration.
 */
export async function assertOAuthForcedReconsentMigration(client: PoolClient, schema: string) {
  const liveTokens = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM "${schema}"."oauth_tokens" WHERE revoked_at IS NULL`,
  )
  if (liveTokens.rows[0]?.count !== "0") {
    throw new Error(
      `Migration 057 postcondition failed: ${liveTokens.rows[0]?.count} unrevoked OAuth token(s) remain.`,
    )
  }

  const consents = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM "${schema}"."oauth_consents"`,
  )
  if (consents.rows[0]?.count !== "0") {
    throw new Error(
      `Migration 057 postcondition failed: ${consents.rows[0]?.count} OAuth consent(s) remain.`,
    )
  }

  const authorizationCodes = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM "${schema}"."oauth_authorization_codes"`,
  )
  if (authorizationCodes.rows[0]?.count !== "0") {
    throw new Error(
      `Migration 057 postcondition failed: ${authorizationCodes.rows[0]?.count} OAuth authorization code(s) remain.`,
    )
  }
}
