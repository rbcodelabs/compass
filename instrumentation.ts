/**
 * Runs once when a Node server instance starts. It only validates
 * configuration: on a non-Vercel production host without COMPASS_ENV the
 * process should refuse to start with a clear message, not fail later on the
 * first request that happens to need the environment.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return
  const { assertCompassEnvConfigured } = await import("./lib/runtime-env")
  assertCompassEnvConfigured()
}
