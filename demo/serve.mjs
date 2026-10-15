#!/usr/bin/env node
/**
 * Serves Compass for the demo recorder (demo.config.json -> target.startCommand).
 *
 * Runs on the recording host, from the project root, with the dev database
 * settings already in the environment (DATABASE_URL, AUTH_SECRET, AUTH_URL,
 * AUTH_TRUST_HOST; see demo/README.md). It:
 *
 *   1. starts `next dev` on :3000 (NODE_ENV=development, the only mode that
 *      has the throwaway "dev-credentials" login; never a deployed build)
 *   2. warms every route and server action the demo touches by running the
 *      whole flow once headlessly (demo/warmup.mjs), so no recorded click
 *      waits on a cold compile
 *   3. re-seeds the sample workspace, wiping what the warm-up created
 *   4. only then opens :3100, which the recorder waits for. A request to
 *      :3100 signs the demo user in against :3000 and redirects into the
 *      app, so the recording starts already signed in (cookies are scoped to
 *      the host, not the port).
 *
 * Refuses to run unless DATABASE_URL points at a local/LAN Postgres.
 */
import { spawn, spawnSync } from "node:child_process";
import * as http from "node:http";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const APP = "http://localhost:3000";
const LANDING = `${APP}/northstar/ember/feedback`;
const DEMO_EMAIL = "maya@northstar.test";

const dbUrl = process.env.DATABASE_URL ?? "";
if (!dbUrl || /amazonaws|dsql|vercel|neon|supabase/i.test(dbUrl) || process.env.PGHOST || process.env.VERCEL_ENV) {
  console.error("demo/serve.mjs: refusing to run without a local DATABASE_URL (never Aurora DSQL, preview or production)");
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (message) => console.error(`[demo-serve] ${message}`);

const next = spawn(process.execPath, [path.join(root, "node_modules/next/dist/bin/next"), "dev", "-p", "3000"], {
  cwd: root,
  stdio: ["ignore", "inherit", "inherit"],
  env: { ...process.env, NODE_ENV: "development" },
});
const stop = async () => {
  next.kill("SIGTERM");
  try {
    await (await import("./warmup.mjs")).closeWarmup();
  } finally {
    process.exit(0);
  }
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
next.on("exit", (code) => {
  log(`next dev exited (${code})`);
  process.exit(code ?? 1);
});

async function waitForApp() {
  for (let i = 0; i < 240; i++) {
    try {
      const response = await fetch(`${APP}/login`);
      if (response.status < 500) return;
    } catch {
      // not up yet
    }
    await sleep(500);
  }
  throw new Error("next dev did not come up within 120s");
}

function reseed() {
  const result = spawnSync("npx", ["tsx", "scripts/seed-demo-intro.ts", "--reset"], { cwd: root, stdio: ["ignore", "inherit", "inherit"], env: process.env });
  if (result.status !== 0) throw new Error("seed-demo-intro.ts failed");
}

/** Sign the demo user in against the dev server and return the Set-Cookie lines for the browser. */
async function signIn() {
  const csrfResponse = await fetch(`${APP}/api/auth/csrf`);
  const { csrfToken } = await csrfResponse.json();
  // Auth.js may send the csrf cookie twice; the last one matches the token in the body.
  const jar = new Map(csrfResponse.headers.getSetCookie().map((c) => c.split(";")[0].split(/=(.*)/s)));
  const csrfCookies = [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
  const response = await fetch(`${APP}/api/auth/callback/dev-credentials`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: csrfCookies },
    body: new URLSearchParams({ csrfToken, email: DEMO_EMAIL, json: "true" }),
  });
  const cookies = response.headers.getSetCookie().filter((c) => /session-token/.test(c));
  if (!cookies.length) throw new Error(`sign-in returned no session cookie (status ${response.status})`);
  return cookies;
}

await waitForApp();
log("next dev is up; warming routes");
const { warmup } = await import("./warmup.mjs");
await warmup(APP, log);
log("re-seeding the sample workspace");
reseed();

http
  .createServer(async (request, response) => {
    try {
      const cookies = await signIn();
      response.writeHead(302, { Location: LANDING, "Set-Cookie": cookies });
    } catch (error) {
      response.writeHead(500);
      response.write(String(error));
    }
    response.end();
  })
  .listen(3100, () => log("ready on :3100"));
