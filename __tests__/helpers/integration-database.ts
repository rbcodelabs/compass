/**
 * Single opt-in for every real-PostgreSQL integration test.
 *
 * Set INTEGRATION_TEST_DATABASE_URL to an isolated local `compass_e2e` database to run them; leave it unset and every
 * suite that imports `integrationDatabaseUrl` skips itself (`describe.skipIf(!integrationDatabaseUrl)`). Each suite
 * creates its own random schema inside that database and drops it on teardown, so one throwaway database serves all.
 *
 *   podman run -d --name compass-itest-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=compass_e2e \
 *     -p 127.0.0.1:5432:5432 docker.io/library/postgres:16
 *   INTEGRATION_TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/compass_e2e pnpm exec vitest run <file>
 *
 * This is deliberately NOT the app's DATABASE_URL / POSTGRES_URL and not the Playwright suite's DATABASE_URL +
 * E2E_ISOLATED_DATABASE guard (e2e/functional/fixtures/isolated-database.ts).
 *
 * Safety guard (the strictest behaviour the per-feature tests used to implement individually): a set value must be a
 * postgres(ql) URL on localhost / 127.0.0.1 whose database is exactly `compass_e2e` and which carries no `?schema=`
 * override. A set-but-unsafe value throws at import so the suite fails loudly rather than silently skipping or, worse,
 * writing to a real database. Other query parameters such as `?sslmode=disable` are allowed.
 *
 * The per-feature variables this replaced are NOT honoured (clean break); if one is set while the new one is not, a
 * one-line hint is printed so a stale local environment is easy to fix.
 */

export const INTEGRATION_DATABASE_ENV = "INTEGRATION_TEST_DATABASE_URL"

export const LEGACY_INTEGRATION_DATABASE_ENVS = [
  "AGENT_RUNS_DATABASE_URL",
  "AGENT_SCOPED_OAUTH_MIGRATIONS_DATABASE_URL",
  "ANALYTICS_MIGRATION_DATABASE_URL",
  "ANTHROPIC_KEY_MIGRATION_DATABASE_URL",
  "CARD_SORT_DATABASE_URL",
  "ENTITY_LINKS_ARTIFACT_DATABASE_URL",
  "ENTITY_LINKS_CONVERSATION_DATABASE_URL",
  "ENTITY_LINKS_DATABASE_URL",
  "ENTITY_LINKS_OPPORTUNITY_DATABASE_URL",
  "ENTITY_LINKS_SOLUTION_KR_DATABASE_URL",
  "ENTITY_LINKS_TASK_DATABASE_URL",
  "LEGACY_DECISION_REPAIR_DATABASE_URL",
  "PM_AGENT_HANDOFF_DATABASE_URL",
  "PREVIEW_QA_DATABASE_URL",
  "READ_PARITY_TEST_DATABASE_URL",
  "RESEARCH_EVIDENCE_PROMOTION_DATABASE_URL",
  "RESEARCH_EXTERNAL_MIGRATION_DATABASE_URL",
  "RESEARCH_PARTICIPANT_VOICE_DATABASE_URL",
  "RESEARCH_VOICE_MIGRATION_DATABASE_URL",
  "RESEARCH_VOICE_TERMINATION_DATABASE_URL",
  "RETENTION_INDEXES_DATABASE_URL",
  "REVIEWS_MIGRATION_DATABASE_URL",
  "THINKING_MODEL_TEST_DATABASE_URL",
  "TOOL_APPROVAL_DATABASE_URL",
  "TYPED_LINK_TEST_DATABASE_URL",
  "UPDATES_TEST_DATABASE_URL",
  "WORKSPACE_DEDUPE_DATABASE_URL",
  "WORKSPACE_EXPORT_DATABASE_URL",
  "WORKSPACE_ID_TEST_DATABASE_URL",
  "WORKSPACE_MODULES_DATABASE_URL",
  "WORK_ITEM_IDS_DATABASE_URL",
] as const

const ALLOWED_PROTOCOLS = ["postgresql:", "postgres:"]
const ALLOWED_HOSTS = ["localhost", "127.0.0.1"]
const REQUIRED_DATABASE = "compass_e2e"

type Env = Record<string, string | undefined>

/** Throws unless `raw` is an isolated local `compass_e2e` URL with no schema override. */
export function assertSafeIntegrationDatabaseUrl(raw: string): URL {
  const reject = (why: string): never => {
    throw new Error(`${INTEGRATION_DATABASE_ENV} must be an isolated local ${REQUIRED_DATABASE} URL without a schema override (${why})`)
  }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return reject("not a parseable URL")
  }
  if (!ALLOWED_PROTOCOLS.includes(url.protocol)) reject(`protocol ${url.protocol}`)
  if (!ALLOWED_HOSTS.includes(url.hostname)) reject(`host ${url.hostname}`)
  if (url.pathname !== `/${REQUIRED_DATABASE}`) reject(`database ${url.pathname}`)
  if (url.searchParams.has("schema")) reject("has ?schema=")
  return url
}

/** Returns the validated opt-in URL, or undefined when unset/blank (suites then skip). */
export function readIntegrationDatabaseUrl(env: Env = process.env): string | undefined {
  const value = env[INTEGRATION_DATABASE_ENV]?.trim()
  if (!value) {
    const stale = LEGACY_INTEGRATION_DATABASE_ENVS.filter((name) => env[name]?.trim())
    if (stale.length > 0) {
      console.warn(`[integration-tests] ${stale.join(", ")} is no longer read; set ${INTEGRATION_DATABASE_ENV} instead. Integration suites are skipped.`)
    }
    return undefined
  }
  assertSafeIntegrationDatabaseUrl(value)
  return value
}

export const integrationDatabaseUrl: string | undefined = readIntegrationDatabaseUrl()
