import fs from "node:fs"

/**
 * E2E_SERVER=prod runs the functional suite against a prebuilt `pnpm build:e2e` artifact (see playwright.config.ts). A stale
 * artifact would silently test old code, so scripts/run-functional-e2e.mjs refuses to start when .next/BUILD_ID is missing or
 * older than the commit at HEAD. Returns an error string, or null when the build is acceptable.
 */
export function prodBuildProblem({ buildIdPath, headCommitMs }) {
  let builtMs
  try {
    builtMs = fs.statSync(buildIdPath).mtimeMs
  } catch {
    return `${buildIdPath} is missing. Run \`pnpm build:e2e\` (COMPASS_E2E_MOCK_AUTH_BUILD=1 next build) before E2E_SERVER=prod.`
  }
  if (builtMs < headCommitMs) {
    return `${buildIdPath} (${new Date(builtMs).toISOString()}) is older than HEAD (${new Date(headCommitMs).toISOString()}). Rebuild with \`pnpm build:e2e\`.`
  }
  return null
}
