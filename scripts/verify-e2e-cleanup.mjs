import pg from "pg";

const connectionString = process.env.DATABASE_URL;
if (process.env.E2E_ISOLATED_DATABASE !== "1" || !connectionString) {
  throw new Error(
    "Cleanup verification requires E2E_ISOLATED_DATABASE=1 and DATABASE_URL",
  );
}

const target = new URL(connectionString);
const database = decodeURIComponent(target.pathname.replace(/^\//, ""));
if (
  !new Set(["localhost", "127.0.0.1", "::1", "[::1]"]).has(target.hostname) ||
  database !== "compass_e2e"
) {
  throw new Error("Cleanup verification refuses any target except local compass_e2e");
}

const pool = new pg.Pool({ connectionString });
try {
  const { rows } = await pool.query(
    `SELECT
       (SELECT COUNT(*)::int FROM compass_dev.organizations
        WHERE slug = 'e2e-test-org') AS fixture_orgs,
       (SELECT COUNT(*)::int FROM public.e2e_database_sentinel
        WHERE value = 'compass-authenticated-e2e') AS sentinels`,
  );
  const result = rows[0];
  if (result?.fixture_orgs !== 0 || result?.sentinels !== 1) {
    throw new Error(
      `Authenticated E2E cleanup verification failed: fixture_orgs=${result?.fixture_orgs}, sentinels=${result?.sentinels}`,
    );
  }
  console.log("[e2e db] Cleanup verified: fixture_orgs=0, sentinels=1");
} finally {
  await pool.end();
}
