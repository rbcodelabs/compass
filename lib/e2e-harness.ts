import { getActiveSchema } from "@/lib/schema"

/**
 * Gate for the e2e-only mock login (provider id "dev-credentials") on a production build.
 *
 * Fails closed. The mock login exists only when ALL of these hold:
 *   1. the artifact was built with COMPASS_E2E_MOCK_AUTH_BUILD=1 (next.config.ts inlines the literal, so a build
 *      without it has the branch below removed by the minifier; scripts/assert-no-mock-auth.mjs proves it),
 *   2. E2E_MOCK_AUTH=1 and E2E_ISOLATED_DATABASE=1 at runtime,
 *   3. no deployed-environment variable is present (VERCEL, VERCEL_ENV, PGHOST, AWS_ROLE_ARN),
 *   4. DATABASE_URL is a local host and the database is compass_e2e, and the active schema is compass_dev.
 * A flagged build that sees a deployed-environment variable throws instead of silently turning off.
 */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"])
const DEPLOYED_ENV = ["VERCEL", "VERCEL_ENV", "PGHOST", "AWS_ROLE_ARN"] as const

export function e2eMockAuthEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  // Literal replaced by next.config.ts `env`; "" in every build that did not opt in.
  if (process.env.COMPASS_E2E_MOCK_AUTH_BUILD !== "1") return false
  // Marker string proving the guard is in this artifact: compass-e2e-mock-auth-v1
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
