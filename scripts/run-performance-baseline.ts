#!/usr/bin/env node
import fs from "node:fs";
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { Pool } from "pg";
import { instrumentPgPool, summarizeObserverOverhead } from "../lib/performance-baseline.ts";
import { setupPerformanceDatabase } from "../e2e/performance/global-setup.ts";
import { teardownPerformanceDatabase } from "../e2e/performance/global-teardown.ts";

const port = Number(process.env.PERF_PORT ?? 4900 + (crypto.createHash("md5").update(process.cwd()).digest().readUInt16BE(0) % 700));
const baseURL = `http://localhost:${port}`;
const sha = process.env.PERF_BUILD_SHA;
if (!sha || sha !== process.env.PERF_EXPECTED_SHA) throw new Error("Exact build SHA is required");
const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (head !== sha) throw new Error("PERF_BUILD_SHA must equal HEAD");
execFileSync("pnpm", ["build"], { stdio: "inherit", env: process.env });
process.env.PERF_EXTERNALLY_MANAGED = "1";

async function waitForSession(sessionToken: string) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseURL}/api/auth/session`, {
        headers: {
          cookie: `authjs.session-token=${sessionToken}`,
          "x-compass-perf-request-id": "perf_runtime_schema_assertion",
        },
      });
      if (response.ok && (await response.json() as { user?: unknown }).user) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Optimized server did not pass authenticated runtime schema assertion");
}

await setupPerformanceDatabase();
const state = JSON.parse(fs.readFileSync(".performance-baseline/run.json", "utf8")) as { schema: string };
const disabledPool = new Pool({ connectionString: process.env.DATABASE_URL });
const enabledPool = new Pool({ connectionString: process.env.DATABASE_URL });
instrumentPgPool(enabledPool as unknown as Parameters<typeof instrumentPgPool>[0], () => undefined, performance.now.bind(performance), () => "perf_observer_probe");
const probeSql = `SELECT run_token FROM "${state.schema}"."_compass_perf_sentinel"`;
const timeQuery = async (pool: Pool) => { const start = performance.now(); await pool.query(probeSql); return performance.now() - start; };
for (let i = 0; i < 3; i++) { await timeQuery(disabledPool); await timeQuery(enabledPool); }
const disabledMs: number[] = [], enabledMs: number[] = [];
const pairedSamples: Array<{ pair: number; order: string; disabledMs: number; enabledMs: number }> = [];
for (let pair = 0; pair < 20; pair++) {
  const enabledFirst = pair % 2 === 1;
  const first = await timeQuery(enabledFirst ? enabledPool : disabledPool);
  const second = await timeQuery(enabledFirst ? disabledPool : enabledPool);
  const disabled = enabledFirst ? second : first, enabled = enabledFirst ? first : second;
  disabledMs.push(disabled); enabledMs.push(enabled);
  pairedSamples.push({ pair, order: enabledFirst ? "enabled-disabled" : "disabled-enabled", disabledMs: disabled, enabledMs: enabled });
}
await Promise.all([disabledPool.end(), enabledPool.end()]);
fs.writeFileSync(".performance-baseline/observer-overhead.json", JSON.stringify({
  ...summarizeObserverOverhead(disabledMs, enabledMs), buildSha: sha,
  warmupsPerMode: 3, ordering: "alternating; reversed for odd pairs",
  queryFingerprint: crypto.createHash("sha256").update("select run_token from sentinel").digest("hex"),
  pairedSamples,
}, null, 2));
const auth = JSON.parse(fs.readFileSync("e2e/performance/.auth/user.json", "utf8")) as { cookies: Array<{ value: string }> };
const env = {
  ...process.env,
  PORT: String(port),
  COMPASS_PERF_BASELINE: "1",
  COMPASS_PERF_SCHEMA: state.schema,
  COMPASS_PERF_REQUEST_ID: "perf_runtime_schema_assertion",
  PERF_EXTERNALLY_MANAGED: "1",
  PERF_BASE_URL: baseURL,
  PERF_STORAGE_STATE: "e2e/performance/.auth/user.json",
};
const server = spawn("pnpm", ["start"], { env, stdio: ["ignore", "pipe", "pipe"] });
let serverLogs = "";
const logPath = ".performance-baseline/local-server.log";
fs.mkdirSync(".performance-baseline", { recursive: true });
fs.writeFileSync(logPath, "");
server.stdout.on("data", (chunk) => { serverLogs += String(chunk); fs.appendFileSync(logPath, chunk); process.stdout.write(chunk); });
server.stderr.on("data", (chunk) => { serverLogs += String(chunk); fs.appendFileSync(logPath, chunk); process.stderr.write(chunk); });
try {
  await waitForSession(auth.cookies[0].value);
  if (!serverLogs.includes("COMPASS_PERF_QUERY")) throw new Error("Runtime emitted no schema assertion query marker");
  const tests = spawn("pnpm", ["test:performance"], { env, stdio: "inherit" });
  const code = await new Promise<number>((resolve) => tests.on("exit", (value) => resolve(value ?? 1)));
  if (code !== 0) throw new Error(`Performance Playwright exited ${code}`);
} finally {
  server.kill("SIGTERM");
  const exited = new Promise<boolean>((resolve) => server.once("exit", () => resolve(true)));
  if (!(await Promise.race([exited, new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5_000))]))) {
    server.kill("SIGKILL");
    await exited;
  }
  await teardownPerformanceDatabase();
}
