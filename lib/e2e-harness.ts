import { getActiveSchema } from "@/lib/schema"

/**
 * Gates for the e2e-only mock login (provider id "dev-credentials") and the functional-suite fakes on a PRODUCTION build.
 *
 * `e2eMockAuthEnabled()` fails closed. Mock mode exists only when ALL of these hold:
 *   1. the artifact was built with COMPASS_E2E_MOCK_AUTH_BUILD=1 (next.config.ts inlines the literal, so in any other build
 *      the gated branch is removed by the minifier; scripts/assert-no-mock-auth.mjs proves it on the artifact),
 *   2. E2E_MOCK_AUTH=1 and E2E_ISOLATED_DATABASE=1 at runtime,
 *   3. no deployed-environment variable is present (VERCEL, VERCEL_ENV, PGHOST, AWS_ROLE_ARN),
 *   4. DATABASE_URL is a local host, the database is compass_e2e, and the active schema is compass_dev.
 * A flagged build that sees a deployed-environment variable throws instead of silently turning off.
 *
 * IMPORTANT for callers: write the build literal INLINE at the call site, `process.env.COMPASS_E2E_MOCK_AUTH_BUILD === "1" && ...`.
 * A bare call to a function leaves that function and everything it imports in the artifact, with a constant-false body.
 * The inline literal is what lets the minifier delete the branch and the modules behind it.
 */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"])
const DEPLOYED_ENV = ["VERCEL", "VERCEL_ENV", "PGHOST", "AWS_ROLE_ARN"] as const

export function e2eMockAuthEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  // Literal replaced by next.config.ts `env`; "" in every build that did not opt in.
  if (process.env.COMPASS_E2E_MOCK_AUTH_BUILD !== "1") return false
  // Marker string proving this guard is in an artifact: compass-e2e-mock-auth-v1
  const marker = "compass-e2e-mock-auth-v1"
  const deployed = DEPLOYED_ENV.filter((name) => env[name])
  if (deployed.length > 0) {
    throw new Error(`${marker}: refusing to boot an e2e mock-auth build with ${deployed.join(", ")} set`)
  }
  if (env.E2E_MOCK_AUTH !== "1" || env.E2E_ISOLATED_DATABASE !== "1") return false
  try {
    const url = new URL(env.DATABASE_URL ?? "")
    if (!LOCAL_HOSTS.has(url.hostname)) return false
    if (decodeURIComponent(url.pathname.replace(/^\//, "")) !== "compass_e2e") return false
  } catch {
    return false
  }
  return getActiveSchema() === "compass_dev"
}

/**
 * The functional-suite fakes (research, PM interview, voice, receipt-failure injection): on under the old dev condition
 * (not production and E2E_FUNCTIONAL=1), or under mock mode on the e2e production build (which still needs E2E_FUNCTIONAL=1,
 * so the fakes stay off in any process the functional runner did not start).
 */
export function e2eHarnessEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NODE_ENV !== "production") return env.E2E_FUNCTIONAL === "1"
  return process.env.COMPASS_E2E_MOCK_AUTH_BUILD === "1" && e2eMockAuthEnabled(env) && env.E2E_FUNCTIONAL === "1"
}
