# Temporary preview performance fixture runbook

This temporary Phase 0 capability creates a deterministic 1,231-row fixture and
one Auth.js database session in the existing `compass_preview` schema, measures
the exact immutable preview deployment, and then deletes and independently
verifies every created row. It performs no DDL, migration, schema, dependency,
OAuth, login-endpoint, production, or product change.

## Security boundary

`POST /api/admin/performance-fixture` is a temporary privileged job, not a login
endpoint. Vercel Deployment Protection and constant-time `MIGRATION_SECRET`
authentication both apply. Before reading the body or constructing a database
client, it requires the system runtime identity `VERCEL_ENV=preview`, the exact
`compass_preview` schema, managed Vercel OIDC, exact Git SHA, exact
`VERCEL_DEPLOYMENT_ID`, and unique system `VERCEL_URL`. Production, aliases,
`DATABASE_URL`, AWS profiles, and static AWS credentials fail as the same `404`.

Requests are strict, flat JSON limited to 16 KiB and expire within 30 minutes.
The server defines the graph and derives every ID from fixture version, SHA,
deployment ID, randomized run ID, entity kind, and ordinal. The session token
exists only in the ignored mode-`0600` Playwright state, the protected seed body
in memory, and the Auth.js row. It is never returned, logged, or put in the
recovery manifest.

## Required preflight

Independently prove the deployment is READY, protected, preview-only, unaliased,
and matches the clean reviewed commit, unique hostname, and `dpl_…` ID. A
non-database runtime probe must prove `VERCEL_DEPLOYMENT_ID`,
`VERCEL_GIT_COMMIT_SHA`, `VERCEL_URL`, and managed OIDC are available. Stop
without seeding if any field is absent.

Set secrets through protected process input, never arguments or logs:

```sh
export COMPASS_PERF_BASELINE=1
export PERF_SERVER_KIND=vercel-preview
export MIGRATION_SECRET="<preview protected secret>"
export VERCEL_AUTOMATION_BYPASS_SECRET="<deployment protection secret>"
export PERF_FIXTURE_RUN_ID="perf_preview_$(node -e 'process.stdout.write(require("node:crypto").randomBytes(16).toString("hex"))')"
export PERF_DEPLOYMENT_SHA="<exact 40-character commit>"
export PERF_DEPLOYMENT_ID="<exact dpl_… ID>"
export PERF_DEPLOYMENT_URL="https://compass-<unique>-rbcodelabs-team.vercel.app/"
```

## Seed and measurement

```sh
pnpm performance:preview-seed -- \
  --run-id "$PERF_FIXTURE_RUN_ID" \
  --deployment-sha "$PERF_DEPLOYMENT_SHA" \
  --deployment-id "$PERF_DEPLOYMENT_ID" \
  --deployment-url "$PERF_DEPLOYMENT_URL" \
  --expires-minutes 20
```

The orchestrator writes the token-free manifest and browser state before the
request. The server rechecks absence/ownership, inserts all 1,231 rows in one
transaction, then performs a fresh exhaustive read. Complete exact replays are
no-write successes; partial or mismatched graphs refuse mutation. Measure only
the same immutable hostname and preserve exact browser, Vercel invocation, and
DSQL query-correlation artifacts.

## Cleanup and independent verification

Cleanup and verify use fresh short-lived requests and may run after the seeded
browser session expires:

```sh
pnpm performance:preview-cleanup -- \
  --run-id "$PERF_FIXTURE_RUN_ID" \
  --deployment-sha "$PERF_DEPLOYMENT_SHA" \
  --deployment-id "$PERF_DEPLOYMENT_ID" \
  --deployment-url "$PERF_DEPLOYMENT_URL"

pnpm performance:preview-verify -- \
  --run-id "$PERF_FIXTURE_RUN_ID" \
  --deployment-sha "$PERF_DEPLOYMENT_SHA" \
  --deployment-id "$PERF_DEPLOYMENT_ID" \
  --deployment-url "$PERF_DEPLOYMENT_URL"
```

Cleanup validates every extant field, relationship, and sentinel, deletes only
deterministic IDs in dependency order inside one transaction, then reads again.
`verify` is a separate read-only request and passes only at zero residue. Keep
the manifest and auth state until an independent reviewer accepts the evidence.

## Mandatory disablement

Phase 0 remains incomplete until: independent verification reports zero residue;
review accepts seed, correlations, cleanup, sanitized logs, and zero-residue
evidence; the exact fixture deployment is deleted and unreachable with no alias;
the route/runtime/orchestration are removed from source; and a subsequent build
proves the route absent. Delete local recovery state only after those gates pass.
