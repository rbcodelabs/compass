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
 * `DATABASE_URL` is the runtime URL. `DATABASE_MIGRATION_URL` is optional and
 * falls back to `DATABASE_URL`, so a deployment with only `DATABASE_URL` set
 * behaves exactly as before.
 */
type Env = Record<string, string | undefined>;

export type PoolerMode = "transaction" | "session";

const TRANSACTION_POOLER_PORT = "6543";

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function getRuntimeDatabaseUrl(env: Env): string | undefined {
  return clean(env.DATABASE_URL);
}

export function getMigrationDatabaseUrl(env: Env): string | undefined {
  return clean(env.DATABASE_MIGRATION_URL) ?? getRuntimeDatabaseUrl(env);
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
