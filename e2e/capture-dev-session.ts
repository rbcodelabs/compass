#!/usr/bin/env node
/**
 * Log in via the dev-credentials NextAuth endpoint directly and save the
 * resulting session as a Playwright storageState JSON file.
 *
 * Why this exists: the login page's "⚡ Dev Login" button hardcodes
 * email=dev@localhost.dev with no way to pick a different user from the UI.
 * Regenerating docs screenshots against a local dev server needs a real
 * seeded account (see seed-screenshots.ts, which requires rick@rbcodelabs.com
 * to already exist) — this script does the CSRF handshake that the button's
 * server action does, but for an arbitrary email.
 *
 * Only works against a local dev server (NODE_ENV=development, where the
 * dev-credentials provider exists at all — see auth.ts). Refuses non-local
 * BASE_URLs so this can't accidentally be pointed at a real deployment.
 *
 * Usage:
 *   BASE_URL=http://localhost:3011 LOGIN_EMAIL=rick@rbcodelabs.com \
 *     OUT_FILE=/tmp/rick-session.json node e2e/capture-dev-session.ts
 *
 * Then use the output as DOCS_SESSION_FILE for `pnpm test:e2e`:
 *   DOCS_BASE_URL=http://localhost:3011 DOCS_SESSION_FILE=/tmp/rick-session.json \
 *     pnpm test:e2e
 *
 * Full local screenshot-regeneration recipe:
 *   1. Start a local dev server against local Postgres (DATABASE_URL in
 *      .env.local already points there by default).
 *   2. Seed demo content: `DATABASE_URL=<local> node seed-screenshots.ts`
 *      (requires rick@rbcodelabs.com / rbcodelabs / compass to already
 *      exist locally — log in as that user once via magic-link/dev-login
 *      flow first if they don't).
 *   3. Capture a session with this script.
 *   4. Run `pnpm test:e2e` with DOCS_BASE_URL + DOCS_SESSION_FILE as above.
 */

const BASE = process.env.BASE_URL || "http://localhost:3011";
const EMAIL = process.env.LOGIN_EMAIL || "rick@rbcodelabs.com";
const OUT = process.env.OUT_FILE || "/tmp/dev-session.json";

function assertLocal(base: string) {
  const { hostname } = new URL(base);
  if (hostname !== "localhost" && hostname !== "127.0.0.1") {
    throw new Error(
      `Refusing to run against non-local BASE_URL "${base}" — the dev-credentials ` +
        "provider only exists when NODE_ENV=development, and this script must never " +
        "be pointed at a real deployment."
    );
  }
}

async function main() {
  assertLocal(BASE);

  const csrfRes = await fetch(`${BASE}/api/auth/csrf`);
  const csrfSetCookies = csrfRes.headers.getSetCookie();
  const { csrfToken } = (await csrfRes.json()) as { csrfToken: string };

  // Multiple Set-Cookie headers for the same name can appear across
  // redirects; the LAST one wins (standard cookie-jar overwrite semantics)
  // and is what actually corresponds to the csrfToken in the JSON body —
  // picking the first one here causes a silent "MissingCSRF" failure.
  const csrfCookie = csrfSetCookies.filter((c) => c.includes("csrf-token")).pop();
  if (!csrfCookie) throw new Error("No csrf cookie returned from /api/auth/csrf");
  const csrfCookiePair = csrfCookie.split(";")[0];

  const form = new URLSearchParams({
    csrfToken,
    email: EMAIL,
    callbackUrl: `${BASE}/dashboard`,
  });

  const loginRes = await fetch(`${BASE}/api/auth/callback/dev-credentials`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: csrfCookiePair,
    },
    body: form.toString(),
    redirect: "manual",
  });

  if (loginRes.status !== 302) {
    throw new Error(`Unexpected login response: ${loginRes.status} ${loginRes.headers.get("location")}`);
  }

  const setCookies = loginRes.headers.getSetCookie();
  const sessionCookie = setCookies.find((c) => c.includes("session-token"));
  if (!sessionCookie) {
    throw new Error(
      `Login redirected to ${loginRes.headers.get("location")} but no session cookie was set. ` +
        `Is ${EMAIL} a real user in the local DB? (see seed-screenshots.ts)`
    );
  }

  const [nameValue] = sessionCookie.split(";");
  const eq = nameValue.indexOf("=");
  const name = nameValue.slice(0, eq);
  const value = nameValue.slice(eq + 1);

  const storageState = {
    cookies: [
      {
        name,
        value,
        domain: new URL(BASE).hostname,
        path: "/",
        expires: -1,
        httpOnly: true,
        secure: false,
        sameSite: "Lax" as const,
      },
    ],
    origins: [],
  };

  const fs = await import("fs");
  fs.writeFileSync(OUT, JSON.stringify(storageState, null, 2));
  console.log(`Saved storageState for ${EMAIL} -> ${OUT}`);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
