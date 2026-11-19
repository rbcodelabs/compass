import pg from "pg";
import { test } from "../fixtures/index";

// DIAG(TASK-199, temporary): leave extra Opportunities behind, the way earlier specs in a full run do, so the dock spec runs against a busy board.
test("seed busy board", async () => {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const { rows } = await pool.query(
    `SELECT w.id FROM "compass_dev".workspaces w JOIN "compass_dev".organizations o ON o.id = w.organization_id WHERE o.slug = 'e2e-test-org' AND w.slug = 'e2e-workspace'`,
  );
  for (const status of ["EXPLORING", "PRIORITIZED", "ACTIVE", "VALIDATING", "UNREVIEWED"]) {
    await pool.query(
      `INSERT INTO "compass_dev".opportunities (id, workspace_id, title, status, sort_order, created_at, updated_at)
       SELECT gen_random_uuid(), $1, 'ZZ diag seed ' || $2::text || ' ' || g, $2, g * 10 - 100, NOW(), NOW() FROM generate_series(1, 20) g`,
      [rows[0].id, status],
    );
  }
  await pool.end();
});
