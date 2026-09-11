# Native timeline safety baseline

This records the reproducible safety baseline for the native-timeline productionization sequence. The original baseline changed test infrastructure only. The current bounded gate also covers the identity-scoped Compass native timeline rollout; SVAR remains the fallback and the default for other workspaces.

## Pinned environment

- Branch base: `c0e54c6323281f4dff73c80ef35338cb49c60d2e` (`main` on 2026-09-01)
- Node: 22.x (`.node-version` contains `22`)
- pnpm: 10.34.5 (`packageManager` and CI use the exact version)
- PostgreSQL: 16, dedicated database `compass_e2e`
- Application schema: `compass_dev`
- Playwright: 1.61.0, Chromium, one worker, zero retries

The initial shell was Node 24.14.1 with pnpm 11.5.2. `pnpm test` failed before Vitest with `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`. Pinning pnpm restored the repository wrapper; an existing worktree first repairs modules noninteractively with `CI=true pnpm install --frozen-lockfile`. Local commands emit an intentional engine warning until the shell is switched to Node 22. CI uses Node 22 from `.node-version` and supplies `CI=true` automatically.

## Captured clean-main baseline

Before this branch changed test infrastructure:

| Check | Result |
|---|---|
| Unit/integration | 151 files, 1,704 tests passed |
| Direct command | `./node_modules/.bin/vitest run` |
| Duration | 22.82s Vitest / 23.62s wall clock |

The previously cited 1,760 count included spike-only tests and is not the clean-main baseline.

## Local isolated Postgres

Use a disposable local PostgreSQL 16 instance. The database name is intentionally fixed: the setup, seed, and teardown guards reject remote hosts, any database other than `compass_e2e`, any schema other than `compass_dev`, a missing opt-in, or a missing sentinel.

Example with the project Podman workflow (choose an unused host port):

```sh
podman run -d \
  --name compass-native-timeline-e2e-pg \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=compass_e2e \
  -p 5437:5432 \
  docker.io/library/postgres:16

export DATABASE_URL='postgresql://postgres:postgres@localhost:5437/compass_e2e?sslmode=disable'
export E2E_ISOLATED_DATABASE=1
pnpm e2e:db:prepare
```

`e2e:db:prepare` validates the target before connecting, creates `compass_dev`, projects the existing Prisma model into only that disposable schema, and installs a control sentinel in `public`. It is safe to rerun; two consecutive preparations must both report that the database is in sync. This local projection is test bootstrap only—it does not create or modify a repository migration.

## Bounded authenticated gate

Run:

```sh
pnpm test:e2e:roadmap
```

The gate runs these serialized journeys (including authentication setup):

1. authenticate the seeded development user and save browser state;
2. create/edit timeline dates and prove persistence on the current SVAR timeline;
3. promote backlog items through Board and Timeline scheduling.
4. edit native dates and prove persistence, switch to classic and back, and capture desktop/mobile screenshots;
5. change squad filters without retaining stale native rows and preserve the filter across fallback;
6. reject URL-based opt-in to native for another workspace.
7. promote backlog feedback through the native quick-add menu and prove Board persistence.

The native spec mirrors the rollout workspace ID only inside the guarded local database, under the run-owned test organization. It does not add a production override. Teardown removes it along with the other test workspaces.

The common Node runner prepares the guarded database, sets `CI=1` so Playwright always starts a fresh server instead of attaching to a stale worktree server, runs the requested scope, and verifies cleanup. `test:e2e:functional` and `test:e2e:all` use the same lifecycle, so established entry points cannot bypass the sentinel. The suite uses one worker and `--retries=0`; retry means rerunning the whole command, including database preparation. Cleanup verification requires zero `e2e-test-org` rows and exactly one control sentinel.

## CI gates

The `checks` job runs install, lint, TypeScript, all unit/integration tests, the optimized build, and UI-system checks. The `authenticated-roadmap` job then starts an ephemeral PostgreSQL 16 service, prepares the guarded database, installs Chromium, runs the bounded authenticated gate, verifies cleanup even when the test step fails, and uploads Playwright artifacts on failure. The existing deployed screenshot job is unchanged in purpose and remains conditional.

## First branch evidence

| Check | Result |
|---|---|
| Guard/workflow RED | Failed because `isolated-database` did not exist |
| Guard/workflow GREEN | 13 tests passed |
| Unit/integration after changes | 152 files, 1,717 tests passed; zero failures |
| TypeScript | Clean after removing stale spike-generated `.next/types` |
| ESLint | Zero errors; 31 pre-existing warnings |
| Optimized production build | Passed; 34.93s wall clock |
| Database preparation | Passed twice consecutively |
| Authenticated roadmap E2E | 3/3 passed through the common lifecycle in 40.2s |
| Post-run cleanup | `fixture_orgs=0`, `sentinels=1` |

The first sandboxed optimized build attempt could not reach Google Fonts. The same build passed when run with normal network access, matching CI conditions.
