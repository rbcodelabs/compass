import fs from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { assertSafeLocalPerformanceDatabase } from "../../lib/performance-baseline.ts";

export default async function globalTeardown() {
  if (process.env.PERF_EXTERNALLY_MANAGED === "1") return;
  await teardownPerformanceDatabase();
}

export async function teardownPerformanceDatabase() {
  if (process.env.PERF_SERVER_KIND !== "local-production") return;
  process.loadEnvFile?.(path.resolve(".env.local"));
  const statePath = path.resolve(".performance-baseline/run.json");
  if (!fs.existsSync(statePath)) return;
  const { schema, runToken } = JSON.parse(fs.readFileSync(statePath, "utf8")) as { schema: string; runToken: string };
  const databaseUrl = process.env.DATABASE_URL!;
  assertSafeLocalPerformanceDatabase(databaseUrl, schema);
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const result = await pool.query(`SELECT run_token FROM "${schema}"."_compass_perf_sentinel"`);
    if (result.rows.length !== 1 || result.rows[0].run_token !== runToken) throw new Error("Performance schema ownership sentinel mismatch");
    await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    fs.rmSync(statePath, { force: true });
    fs.rmSync(path.resolve("e2e/performance/.auth/user.json"), { force: true });
  } finally {
    await pool.end();
  }
}
