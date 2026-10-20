/**
 * Connection-string selection for the plain-Postgres (Supabase) path.
 *
 * Two kinds of traffic need different pooler modes:
 *
 * - App runtime (Prisma, Auth.js adapter) is stateless per statement/transaction
 *   and should use Supabase's TRANSACTION-mode pooler (port 6543), where a
 *   backend connection is held only for the duration of a transaction.
 * - The migration runner and any session-state work (advisory locks, SET,
 *   LISTEN, long multi-statement DDL) must use a SESSION-mode or direct
 *   connection (port 5432).
 *
 * Resolution order (first non-blank wins):
 * - runtime:    DATABASE_URL, then POSTGRES_URL (Vercel Supabase integration,
 *               transaction pooler)
 * - migrations: DATABASE_MIGRATION_URL, then POSTGRES_URL_NON_POOLING, then the
 *               runtime URL
 *
 * A deployment with only `DATABASE_URL` set behaves exactly as before.
 *
 * Automation previews (PREVIEW_AUTOMATION_ENABLED / vercel-managed) ignore the
 * integration and migration variables entirely, so an integration that injects
 * POSTGRES_* into preview environments cannot turn them into plain-Postgres
 * deployments. `DATABASE_URL` stays forbidden there (see lib/db.ts).
 */
type Env = Record<string, string | undefined>;

export type PoolerMode = "transaction" | "session";

const TRANSACTION_POOLER_PORT = "6543";

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function isAutomationPreview(env: Env): boolean {
  return env.PREVIEW_AUTOMATION_ENABLED === "1" || env.PREVIEW_DATABASE_MODE === "vercel-managed";
}

/**
 * Integration URLs look like `...:6543/postgres?sslmode=require&supa=base-pooler.x`.
 * - `supa` is a Supabase-internal marker; drop it.
 * - pg-connection-string >= 2.9 treats `sslmode=require` as `verify-full`, but the
 *   Supabase pooler presents a certificate chain rooted in Supabase's own CA, so
 *   the handshake fails with "self-signed certificate in certificate chain".
 *   Opt in to libpq semantics (`uselibpqcompat=true`), under which `require`
 *   means "encrypt, do not verify" - what the integration URL intends. Supply
 *   `sslrootcert` (and use `verify-full`) in an explicit URL for full verification.
 */
export function normalizeIntegrationUrl(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    url.searchParams.delete("supa");
    if (url.searchParams.get("sslmode") === "require" && !url.searchParams.has("uselibpqcompat") && !url.searchParams.has("sslrootcert")) {
      url.searchParams.set("uselibpqcompat", "true");
    }
    return url.toString();
  } catch {
    return connectionString;
  }
}

export function getRuntimeDatabaseUrl(env: Env): string | undefined {
  const explicit = clean(env.DATABASE_URL);
  if (explicit) return explicit;
  if (isAutomationPreview(env)) return undefined;
  const integration = clean(env.POSTGRES_URL);
  return integration ? normalizeIntegrationUrl(integration) : undefined;
}

export function getMigrationDatabaseUrl(env: Env): string | undefined {
  if (!isAutomationPreview(env)) {
    const explicit = clean(env.DATABASE_MIGRATION_URL);
    if (explicit) return explicit;
    const nonPooling = clean(env.POSTGRES_URL_NON_POOLING);
    if (nonPooling) return normalizeIntegrationUrl(nonPooling);
  }
  return getRuntimeDatabaseUrl(env);
}

/**
 * True when this deployment talks to plain Postgres rather than Aurora DSQL.
 * Replaces ad-hoc `process.env.DATABASE_URL` truthiness checks.
 */
export function usesPlainPostgres(env: Env): boolean {
  return getMigrationDatabaseUrl(env) !== undefined;
}

/**
 * Supabase serves its transaction pooler on port 6543. `DATABASE_POOLER_MODE`
 * (`transaction` | `session`) overrides detection for non-Supabase poolers.
 */
export function getPoolerMode(connectionString: string, env: Env): PoolerMode {
  const override = clean(env.DATABASE_POOLER_MODE)?.toLowerCase();
  if (override === "transaction" || override === "session") return override;
  try {
    return new URL(connectionString).port === TRANSACTION_POOLER_PORT ? "transaction" : "session";
  } catch {
    return "session";
  }
}
