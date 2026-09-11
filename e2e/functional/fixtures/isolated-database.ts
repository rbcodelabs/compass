import pg from "pg";

export const E2E_DATABASE_GUARD_ENV = "E2E_ISOLATED_DATABASE";
export const E2E_DATABASE_NAME = "compass_e2e";
export const E2E_SCHEMA = "compass_dev";
export const E2E_SENTINEL = "compass-authenticated-e2e";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function requireIsolatedE2EDatabaseMode(): void {
  if (process.env[E2E_DATABASE_GUARD_ENV] !== "1") {
    throw new Error(
      `Authenticated E2E requires ${E2E_DATABASE_GUARD_ENV}=1 before it can mutate Postgres`,
    );
  }
}

export function validateIsolatedE2EDatabaseTarget(
  connectionString: string,
  activeSchema: string,
): void {
  const parsed = new URL(connectionString);
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));

  if (!LOCAL_HOSTS.has(parsed.hostname)) {
    throw new Error(
      `Authenticated E2E refuses non-local Postgres host: ${parsed.hostname}`,
    );
  }
  if (database !== E2E_DATABASE_NAME) {
    throw new Error(
      `Authenticated E2E requires database ${E2E_DATABASE_NAME}; received ${database || "(empty)"}`,
    );
  }
  if (activeSchema !== E2E_SCHEMA) {
    throw new Error(
      `Authenticated E2E requires schema ${E2E_SCHEMA}; received ${activeSchema}`,
    );
  }
}

export function validateIsolatedE2ESentinel(
  rows: ReadonlyArray<{ value: string }>,
): void {
  if (rows.length !== 1 || rows[0]?.value !== E2E_SENTINEL) {
    throw new Error(
      "Authenticated E2E isolated-database sentinel is absent; run pnpm e2e:db:prepare first",
    );
  }
}

export function isolatedE2EConnectionString(): string {
  requireIsolatedE2EDatabaseMode();
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("Authenticated E2E refuses to run without DATABASE_URL");
  }

  const activeSchema = process.env.PGSCHEMA
    ? `${process.env.PGSCHEMA}_dev`
    : E2E_SCHEMA;
  validateIsolatedE2EDatabaseTarget(connectionString, activeSchema);
  return connectionString;
}

export async function assertIsolatedE2EDatabase(): Promise<void> {
  const pool = new pg.Pool({ connectionString: isolatedE2EConnectionString() });
  try {
    const { rows } = await pool.query<{ value: string }>(
      "SELECT value FROM public.e2e_database_sentinel WHERE value = $1",
      [E2E_SENTINEL],
    );
    validateIsolatedE2ESentinel(rows);
  } finally {
    await pool.end();
  }
}
