/**
 * The one place that decides which Compass environment this process is.
 *
 * Compass used to read `VERCEL_ENV` directly in about twenty places. That is
 * correct on Vercel, which always sets it, and silently wrong everywhere else:
 * on any other host `VERCEL_ENV` is unset, so a production deployment would
 * select the empty `compass_dev` schema and skip the production URL guards
 * without any error. This module makes the environment an explicit setting.
 *
 * Resolution order:
 *   1. `COMPASS_ENV` (`production` | `preview` | `development`) when set.
 *      An unrecognised value throws; it is never guessed at.
 *   2. `VERCEL_ENV`, so Vercel keeps working with no configuration change.
 *      `production` and `preview` map to themselves; any other value
 *      (Vercel's own `development`, or something unexpected) is `development`.
 *   3. Neither is set and `NODE_ENV` is `production`: throw. A production
 *      build running on a host that told us nothing must not quietly behave
 *      like a developer laptop.
 *   4. Otherwise (local dev, tests): `development`.
 *
 * Step 3 is skipped while `next build` is collecting page data
 * (`NEXT_PHASE=phase-production-build`). A production image is often built
 * before the environment it will run in is known, and nothing the build does
 * depends on the answer.
 */
export type CompassEnv = "production" | "preview" | "development"

type EnvSource = Record<string, string | undefined>

const COMPASS_ENVS: readonly CompassEnv[] = ["production", "preview", "development"]

export function compassEnv(env: EnvSource = process.env): CompassEnv {
  const explicit = env.COMPASS_ENV?.trim()
  if (explicit) {
    if ((COMPASS_ENVS as readonly string[]).includes(explicit)) return explicit as CompassEnv
    throw new Error(
      `COMPASS_ENV must be one of ${COMPASS_ENVS.join(", ")} (got "${explicit}").`,
    )
  }

  const vercel = env.VERCEL_ENV?.trim()
  if (vercel) return vercel === "production" || vercel === "preview" ? vercel : "development"

  if (env.NODE_ENV === "production" && env.NEXT_PHASE !== "phase-production-build") {
    throw new Error(
      "COMPASS_ENV is not set. Outside Vercel, set COMPASS_ENV to production, preview or development; " +
        "Compass will not guess, because the environment selects the database schema " +
        "(compass_prod / compass_preview / compass_dev) and the production URL guards.",
    )
  }

  return "development"
}

/** Throws at server start when the environment is unresolved. Called from instrumentation.ts. */
export function assertCompassEnvConfigured(env: EnvSource = process.env): CompassEnv {
  return compassEnv(env)
}
