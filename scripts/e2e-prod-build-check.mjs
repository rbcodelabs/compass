import fs from "node:fs"

/**
 * Resolves the functional E2E server mode from `process.env.E2E_SERVER`.
 * Defaults to `"prod"` (`next start` on the `pnpm build:e2e` artifact); only `"dev"` opts back into `pnpm dev`.
 *
 * @param {string | undefined} raw
 * @returns {"prod" | "dev"}
 */
export function e2eServerMode(raw) {
  if (raw === undefined || raw === "" || raw === "prod") return "prod"
  if (raw === "dev") return "dev"
  throw new Error(`E2E_SERVER=${raw} is not recognised. Leave it unset or "prod" for the production build, or set E2E_SERVER=dev for pnpm dev.`)
}

/**
 * The default `prod` server mode runs the functional suite against a prebuilt `pnpm build:e2e` artifact (see playwright.config.ts).
 * A stale artifact would silently test old code, so scripts/run-functional-e2e.mjs refuses to start when .next/BUILD_ID is missing or
 * older than the commit at HEAD. Returns a single-line error string, or null when the build is acceptable.
 *
 * @param {{ buildIdPath: string, headCommitMs: number }} options
 * @returns {string | null}
 */
export function prodBuildProblem({ buildIdPath, headCommitMs }) {
  let builtMs
  try {
    builtMs = fs.statSync(buildIdPath).mtimeMs
  } catch {
    return `${buildIdPath} is missing. Run \`pnpm build:e2e\` (COMPASS_E2E_MOCK_AUTH_BUILD=1 next build) first, or set E2E_SERVER=dev for \`pnpm dev\`.`
  }
  if (builtMs < headCommitMs) {
    return `${buildIdPath} (${new Date(builtMs).toISOString()}) is older than HEAD (${new Date(headCommitMs).toISOString()}). Rebuild with \`pnpm build:e2e\`, or set E2E_SERVER=dev for \`pnpm dev\`.`
  }
  return null
}
