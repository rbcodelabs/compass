/**
 * Proof that the e2e mock login is off by default, even inside the artifact that contains it.
 *
 * `pnpm build:e2e` compiles the mock login in; at runtime it also needs E2E_MOCK_AUTH=1 (set only by playwright.config.ts for the
 * suite's own server). This spec starts a SECOND `next start` on the same artifact WITHOUT E2E_MOCK_AUTH and checks that:
 *   - /login has no Dev Login button,
 *   - /api/auth/providers does not list dev-credentials,
 *   - POST /api/auth/callback/dev-credentials with a real CSRF token does not authenticate anyone (no session cookie, and
 *     /api/auth/session stays null).
 *
 * Only meaningful against the production artifact, so it skips in the default dev-server mode (E2E_SERVER unset).
 */
import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";

test.describe("mock login is off without E2E_MOCK_AUTH", () => {
  test.skip(process.env.E2E_SERVER !== "prod", "needs the E2E_SERVER=prod artifact (pnpm build:e2e)");

  let server: ChildProcess | undefined;
  let baseUrl = "";
  let serverLog = "";

  async function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const probe = net.createServer();
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", () => {
        const { port } = probe.address() as net.AddressInfo;
        probe.close(() => resolve(port));
      });
    });
  }

  test.beforeAll(async () => {
    test.setTimeout(90_000);
    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    const env: NodeJS.ProcessEnv = { ...process.env, PORT: String(port), AUTH_TRUST_HOST: "true", AUTH_URL: baseUrl, NODE_ENV: "production" };
    delete env.E2E_MOCK_AUTH;
    server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-H", "127.0.0.1", "-p", String(port)], { env, stdio: ["ignore", "pipe", "pipe"] });
    server.stdout?.on("data", (chunk) => (serverLog += chunk));
    server.stderr?.on("data", (chunk) => (serverLog += chunk));
    const deadline = Date.now() + 60_000;
    for (;;) {
      try {
        if ((await fetch(`${baseUrl}/login`)).status === 200) break;
      } catch {
        // not listening yet
      }
      if (Date.now() > deadline) throw new Error(`second server never became ready:\n${serverLog.slice(-2000)}`);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  });

  test.afterAll(async () => {
    if (!server || server.exitCode !== null) return;
    server.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (server.exitCode === null) server.kill("SIGKILL");
  });

  test("/login renders no Dev Login button and no dev-only section", async () => {
    const html = await (await fetch(`${baseUrl}/login`)).text();
    expect(html).toContain("Sign in to Compass");
    expect(html).not.toContain("Dev Login");
    expect(html).not.toContain("dev only");
  });

  test("the credentials callback does not authenticate anyone", async () => {
    const providers = (await (await fetch(`${baseUrl}/api/auth/providers`)).json()) as Record<string, unknown>;
    expect(Object.keys(providers)).not.toContain("dev-credentials");

    const csrfResponse = await fetch(`${baseUrl}/api/auth/csrf`);
    const { csrfToken } = (await csrfResponse.json()) as { csrfToken: string };
    const csrfCookies = csrfResponse.headers.getSetCookie().map((cookie) => cookie.split(";")[0]);

    const response = await fetch(`${baseUrl}/api/auth/callback/dev-credentials`, {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: csrfCookies.join("; ") },
      body: new URLSearchParams({ csrfToken, email: "intruder@example.com", callbackUrl: `${baseUrl}/dashboard` }),
    });
    const setCookies = response.headers.getSetCookie();
    expect(setCookies.filter((cookie) => /session-token/.test(cookie))).toEqual([]);
    expect(response.headers.get("location") ?? "").not.toMatch(/\/dashboard/);

    const session = await fetch(`${baseUrl}/api/auth/session`, { headers: { Cookie: [...csrfCookies, ...setCookies.map((cookie) => cookie.split(";")[0])].join("; ") } });
    expect(await session.json()).toBeNull();
  });
});
