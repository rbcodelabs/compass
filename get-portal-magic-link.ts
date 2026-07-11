#!/usr/bin/env node
// Trigger a portal magic-link send against the local dev server and print
// the resulting verify URL, for manual testing without a real inbox.
//
// Note on why this hits the API instead of querying Postgres directly (like
// get-magic-link.ts does for the internal Auth.js flow): portal_verification_tokens
// deliberately stores only a sha256 hash of the token (mirroring ApiKey.keyHash),
// never the raw value — so a DB read alone can never be turned into a usable
// magic link (see ADR: Claude/compass-portal-auth-adr-2026-07-03.md). The raw
// token only ever exists transiently in the /api/portal/auth/send response
// (dev-only devVerifyUrl field, present only when AUTH_RESEND_KEY is unset
// and NODE_ENV !== "production") and in the server's console.log. This script
// reads it from that dev-only response field.
//
// Usage: node --experimental-strip-types get-portal-magic-link.ts <email> [returnTo]

import path from "path";

// Load .env.local so NEXT_PUBLIC_APP_URL matches whatever port this worktree's
// dev server actually started on (mirrors e2e/functional/global-setup.ts).
try {
  process.loadEnvFile(path.resolve(process.cwd(), ".env.local"));
} catch {
  // .env.local may not exist — fall back to whatever is already in the env.
}

const email = process.argv[2];
const returnTo = process.argv[3];

if (!email) {
  console.error("Usage: node --experimental-strip-types get-portal-magic-link.ts <email> [returnTo]");
  process.exit(1);
}

const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

const res = await fetch(`${appUrl}/api/portal/auth/send`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email, ...(returnTo ? { returnTo } : {}) }),
});

if (!res.ok) {
  console.error(`Request failed: ${res.status} ${await res.text()}`);
  process.exit(1);
}

const data = (await res.json()) as { success: boolean; devVerifyUrl?: string };

if (!data.devVerifyUrl) {
  console.log(
    "No devVerifyUrl in response. Either AUTH_RESEND_KEY is set (a real email " +
      "was sent instead), NODE_ENV=production, or a live unexpired token " +
      "already exists for this email (per-email throttle — check the dev " +
      "server's console.log for the original [portal-auth] Magic link line)."
  );
  process.exit(0);
}

console.log(`Verify URL:\n${data.devVerifyUrl}`);
