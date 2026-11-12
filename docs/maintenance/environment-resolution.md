# Environment resolution (`COMPASS_ENV`)

Compass needs to know whether a process is `production`, `preview` or
`development`. The answer selects the database schema (`compass_prod`,
`compass_preview`, `compass_dev`), enables or disables preview-only features,
and turns on the production URL guards.

`lib/runtime-env.ts` is the single place that decides. Do not read `VERCEL_ENV`
directly in application code; call `compassEnv()`.

## Resolution order

1. `COMPASS_ENV` (`production` | `preview` | `development`), when set. An
   unrecognised value throws; it is never guessed at. Surrounding whitespace is
   ignored and an empty value counts as unset.
2. `VERCEL_ENV`. `production` and `preview` map to themselves; any other value
   maps to `development`. This is why **Vercel deployments need no
   configuration change**: Vercel always sets `VERCEL_ENV`, and the result is the
   same as before `COMPASS_ENV` existed.
3. Neither is set and `NODE_ENV=production`: throw. A production build on a host
   that told us nothing must not quietly behave like a developer machine (the
   wrong schema and no production URL guards, with no error).
4. Otherwise (local development, tests): `development`.

Step 3 is skipped while `next build` is collecting page data
(`NEXT_PHASE=phase-production-build`), because an image is often built before
the environment it will run in is known and the build does not depend on the
answer.

## Fail at startup

`instrumentation.ts` calls `assertCompassEnvConfigured()` when a Node server
starts, so a misconfigured host refuses to start with a message naming the
variable, instead of failing on the first request that happens to need it.

## Running somewhere other than Vercel

Set `COMPASS_ENV` explicitly in the process environment. Other checks that only
ask "is this a Vercel deployment at all" (for example the local-fixture guards)
still read `VERCEL_ENV` on purpose; they are not environment selection.
