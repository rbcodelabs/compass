// A Postgres session advisory lock that serializes functional E2E runs
// against the shared local `compass_e2e` database.
//
// Why this exists: `pnpm test:e2e:functional` mutates one fixed, shared
// fixture (org slug `e2e-test-org`, workspace slug `e2e-workspace`) and runs
// `prisma db push` against the shared `compass_dev` schema on every
// invocation. Nothing previously stopped two concurrent invocations — two
// agent sessions, or a human and an agent, each in their own git worktree —
// from doing this at the same time. Observed effects of that, reproduced
// deterministically on 2026-09-17 by running two clean checkouts against the
// same `compass_e2e` database simultaneously:
//
//   - Both runs seed into the *same* org/workspace/user rows (the seed is
//     upsert-by-slug), so mid-run assertions see each other's data:
//     `getByText("Native backlog bug")` resolving to 2 elements instead of 1,
//     "Edit dates for <fixture title>" buttons duplicated, etc.
//   - `global-teardown.ts`'s run-token ownership check works as designed and
//     refuses to delete an org another run has since re-stamped — but the
//     run whose teardown was refused then fails its own
//     `verify-e2e-cleanup.mjs` check (`fixture_orgs=1`), so a run can be
//     reported failed for reasons that have nothing to do with the code
//     under test.
//   - `prepare-e2e-database.mjs`'s `prisma db push` is not safe to run twice
//     in overlapping windows against schema that needs a destructive change
//     (see the `--accept-data-loss` fix alongside this file) — a second push
//     landing mid-diff can observe a different delta than a clean run would.
//
// A single Postgres advisory lock, held for the *entire* run (database prep
// through final cleanup verification), is the smallest fix that actually
// closes this: it is keyed to the database connection itself rather than a
// filesystem path, so it correctly serializes two sessions regardless of
// which worktree either one is running from — including the exact scenario
// observed during the Pin Mode Phase 1 build, where one session ran the
// suite from inside another session's worktree. No new dependency (the `pg`
// package is already used throughout this suite), no schema change, and no
// change to application code.
//
// Deliberately a *session*-level lock (pg_advisory_lock / pg_advisory_unlock)
// held on one dedicated connection for the run's lifetime, not a
// transaction-level lock — the run spans multiple child processes and
// connections, so nothing here is inside a single transaction.
import pg from "pg";

// Fixed, arbitrary 63-bit key. MUST stay a constant, independent of cwd or
// worktree path — unlike playwright.config.ts's FUNCTIONAL_PORT hash (which
// *should* vary per worktree, to let concurrent dev servers coexist), this
// lock exists specifically to make two different worktrees serialize against
// each other. Deriving it from `process.cwd()` the way the port is derived
// would silently defeat the entire point: two worktrees would take out two
// different locks and never block each other. See
// `e2e-run-lock.key-is-constant.test.mjs` for the regression test guarding
// this.
export const E2E_RUN_LOCK_KEY = 6_820_147_301_918_223n;

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * Validates that `env.DATABASE_URL` targets the disposable, sandboxed local
 * e2e database — the same guard every other script in this pipeline applies
 * before touching Postgres — and returns the connection string.
 *
 * Takes the child-process `env` object each caller already builds (see
 * run-functional-e2e.mjs) rather than reading this process's own
 * `process.env`: what matters is what the spawned prepare/test/cleanup
 * children will actually connect to, not whatever this parent process
 * happened to be started with.
 */
export function assertIsolatedE2EConnectionString(env) {
  const connectionString = env?.DATABASE_URL;
  if (env?.E2E_ISOLATED_DATABASE !== "1" || !connectionString) {
    throw new Error(
      "The functional E2E run lock requires E2E_ISOLATED_DATABASE=1 and DATABASE_URL",
    );
  }
  const target = new URL(connectionString);
  const database = decodeURIComponent(target.pathname.replace(/^\//, ""));
  if (!LOCAL_HOSTS.has(target.hostname) || database !== "compass_e2e") {
    throw new Error(
      "The functional E2E run lock refuses any target except local compass_e2e",
    );
  }
  return connectionString;
}

/**
 * Runs `fn` while holding a Postgres session advisory lock scoped to the
 * shared `compass_e2e` database. Blocks (with a one-time log line) if
 * another run already holds it, so two concurrent invocations serialize
 * instead of corrupting each other's fixture data.
 *
 * @param {Record<string, string | undefined>} env The env object the run's
 *   child processes will use — validated with the same isolated-database
 *   guard they apply themselves.
 * @param {() => Promise<number>} fn Runs the actual prepare/test/cleanup
 *   sequence and resolves with its process exit code.
 * @returns {Promise<number>} `fn`'s exit code, or a non-zero code if the
 *   lock itself could not be acquired/released.
 */
export async function withE2ERunLock(env, fn) {
  const client = new pg.Client({ connectionString: assertIsolatedE2EConnectionString(env) });
  await client.connect();
  try {
    const { rows } = await client.query(
      "SELECT pg_try_advisory_lock($1::bigint) AS acquired",
      [E2E_RUN_LOCK_KEY.toString()],
    );
    if (!rows[0]?.acquired) {
      console.log(
        "[e2e lock] Another functional E2E run is using compass_e2e — waiting for it to finish...",
      );
      await client.query("SELECT pg_advisory_lock($1::bigint)", [E2E_RUN_LOCK_KEY.toString()]);
      console.log("[e2e lock] Acquired — proceeding.");
    } else {
      console.log("[e2e lock] Acquired compass_e2e run lock.");
    }

    return await fn();
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock($1::bigint)", [E2E_RUN_LOCK_KEY.toString()]);
    } finally {
      await client.end();
    }
  }
}
