/**
 * Per-run ownership token for the shared e2e org.
 *
 * The functional suite seeds everything under one fixed slug (`e2e-test-org`)
 * and the seed is upsert-only (`ON CONFLICT (slug) DO UPDATE`), so a second
 * run that starts while a first is still around **reuses the same org row**.
 * Teardown then deletes that row by slug — which means a teardown belonging to
 * an interrupted run happily deletes the *live* run's data.
 *
 * Observed three times while working on #120/#121: the seed logs
 * `Seed complete ✓`, then the very first spec hits a bare 404 because the org
 * vanished underneath it, and every later spec fails too. One such run took
 * 42 minutes and left 12 tests never executed — all phantom failures that cost
 * real debugging time before the cause was understood.
 *
 * Fix: globalSetup stamps the org's `name` with a token unique to this run and
 * remembers it here. globalTeardown only deletes when the stamp still matches,
 * so a stale teardown finds someone else's stamp and refuses.
 *
 * The token is deliberately held **in this process only** (a module variable,
 * mirrored into `process.env` for resilience) rather than on disk. Playwright
 * runs globalSetup and globalTeardown in the same runner process, so this is
 * durable enough — and unlike a shared file it cannot be clobbered by a
 * concurrent run's setup, which would otherwise hand a stale teardown the
 * *new* run's token and defeat the entire check.
 */
const ENV_KEY = "E2E_RUN_TOKEN";

let runToken: string | null = null;

/** Name stamped onto the seeded org so teardown can prove ownership. */
export function orgNameForToken(token: string): string {
  return `E2E Test Org [${token}]`;
}

export function setRunToken(token: string): void {
  runToken = token;
  process.env[ENV_KEY] = token;
}

/** This run's token, or null if globalSetup never claimed the org. */
export function readRunToken(): string | null {
  return runToken ?? process.env[ENV_KEY] ?? null;
}

export function clearRunToken(): void {
  runToken = null;
  delete process.env[ENV_KEY];
}
