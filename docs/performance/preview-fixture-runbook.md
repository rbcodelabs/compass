# Preview performance fixture runbook

This utility creates the Phase 0 measurement graph in the existing
`compass_preview` schema when normal preview authentication cannot be used. It
does not create schemas, migrate data, configure authentication, change a
deployment, or select an endpoint. It must be run only after the exact preview
deployment and its Git SHA have been independently verified.

The fixture matches the local baseline scale and target records: 10 users, one
organization, one workspace, 10 organization and workspace memberships, five
squads, three OKR cycles, 15 objectives, 60 key results, 40 opportunities, 80
solutions, 160 assumptions, 320 evidence rows, 40 experiments, 75 roadmap
items, 250 feedback rows, 150 tasks, and one short-lived Auth.js database
session. No transaction contains more than 3,000 rows.

## Preconditions

- The checkout is clean at the exact commit deployed to the preview.
- `VERCEL_ENV=preview`, `COMPASS_PERF_BASELINE=1`, and
  `PERF_SERVER_KIND=vercel-preview` are explicitly set.
- `VERCEL_GIT_COMMIT_SHA` is the independently verified deployment SHA.
- `PGSCHEMA=compass`; the derived active schema must be exactly
  `compass_preview`.
- `DATABASE_URL` is unset and `PGHOST` is an Aurora DSQL endpoint.
- `AWS_ROLE_ARN`, `AWS_REGION`, and a current `VERCEL_OIDC_TOKEN` are present
  for dynamic IAM credentials. Never print or persist the OIDC token.
- The exact deployment URL is an allowlisted immutable
  `compass-*-rbcodelabs-team.vercel.app` URL, not an alias, and the exact
  `dpl_*` deployment ID is known.

The CLI proves all of these conditions before it constructs a database client.
It also refuses an existing recovery manifest or auth state, tracked output
paths, production schemas/environments/URLs, a dirty checkout, or any SHA
mismatch.

The canonical Vercel link is the Compass project in
`/Users/rickbowman/projects/compass`: project
`prj_BofzJ65kFnTykvTkoti7o4hjvxw9`, team
`team_qjKFRvZrF6oR8L9yCtqi8AYU`. The worktree itself is intentionally not
linked. Run the utility through that canonical link so Vercel supplies the
short-lived OIDC token, then change into this exact-commit worktree before the
utility starts. AWS console access, `aws login`, AWS profiles, static access
keys, and the default AWS credential chain are neither expected nor supported.

## Seed

Generate a new 128-bit randomized identity and keep the exact deployment values
explicit:

```sh
export PERF_FIXTURE_RUN_ID="perf_preview_$(node -e 'process.stdout.write(require("node:crypto").randomBytes(16).toString("hex"))')"
export PERF_DEPLOYMENT_SHA="<40-character deployed git SHA>"
export PERF_VERIFIED_DEPLOYMENT_SHA="<same SHA, copied from independent deployment verification>"
export PERF_DEPLOYMENT_URL="https://compass-<deployment>-rbcodelabs-team.vercel.app"
export PERF_DEPLOYMENT_ID="dpl_<exact deployment ID>"
export VERCEL_ENV="preview"
export VERCEL_GIT_COMMIT_SHA="$PERF_VERIFIED_DEPLOYMENT_SHA"
export COMPASS_PERF_BASELINE="1"
export PERF_SERVER_KIND="vercel-preview"

pnpm exec vercel env run \
  --cwd /Users/rickbowman/projects/compass \
  -e preview \
  --git-branch chore/performance-baseline \
  -- /bin/zsh -c '
    cd /Users/rickbowman/.geode/worktrees/compass/chore/performance-baseline || exit 1
    exec pnpm performance:preview-seed -- \
      --run-id "$PERF_FIXTURE_RUN_ID" \
      --deployment-sha "$PERF_DEPLOYMENT_SHA" \
      --verified-deployment-sha "$PERF_VERIFIED_DEPLOYMENT_SHA" \
      --deployment-url "$PERF_DEPLOYMENT_URL" \
      --deployment-id "$PERF_DEPLOYMENT_ID" \
      --expires-minutes 120
  '
```

The recovery manifest is written mode `0600` to
`.performance-baseline/preview-fixtures/<run-id>.json` before the first database
write. It contains exact planned cleanup IDs, confirmed-created IDs, counts,
parent sentinel identity, deployment provenance, and expiry. It never contains
the session token, database endpoint, IAM material, or other credentials.

The session token exists only in the ignored mode-`0600`
`e2e/performance/.auth/preview-user.json`. Use the fixture with:

```sh
export PERF_BASE_URL="$PERF_DEPLOYMENT_URL"
export PERF_STORAGE_STATE="e2e/performance/.auth/preview-user.json"
export PERF_BUILD_SHA="$PERF_DEPLOYMENT_SHA"
export PERF_EXPECTED_SHA="$PERF_DEPLOYMENT_SHA"
export PERF_ORG_SLUG="${PERF_FIXTURE_RUN_ID//_/-}"
export PERF_WORKSPACE_SLUG="${PERF_FIXTURE_RUN_ID//_/-}-workspace"
export PERF_OPPORTUNITY_TITLE="Performance Opportunity Target"
export PERF_ROADMAP_ITEM_TITLE="Performance Roadmap Target"

pnpm test:performance
```

The preview lane remains valid only when browser request IDs reconcile exactly
to Vercel invocations and DSQL query envelopes under the Phase 0 contract.

## Cleanup and recovery

Run cleanup from the same exact clean commit with the same deployment identity
and guarded environment:

```sh
pnpm exec vercel env run \
  --cwd /Users/rickbowman/projects/compass \
  -e preview \
  --git-branch chore/performance-baseline \
  -- /bin/zsh -c '
    cd /Users/rickbowman/.geode/worktrees/compass/chore/performance-baseline || exit 1
    exec pnpm performance:preview-cleanup -- \
      --run-id "$PERF_FIXTURE_RUN_ID" \
      --deployment-sha "$PERF_DEPLOYMENT_SHA" \
      --verified-deployment-sha "$PERF_VERIFIED_DEPLOYMENT_SHA" \
      --deployment-url "$PERF_DEPLOYMENT_URL" \
      --deployment-id "$PERF_DEPLOYMENT_ID"
  '
```

Cleanup reads the owner-only manifest, re-proves the environment, schema,
commit, deployment URL, and deployment ID, and verifies every extant recorded
row belongs to the recorded parent sentinels before deleting anything. It
deletes only the manifest's exact IDs in application-safe dependency order,
using batches of at most 3,000 rows. The Auth.js session is deleted by its
recorded database ID, never by its token.

After deletion, the utility queries all recorded IDs plus every randomized user
email and organization/workspace slug. It removes the manifest and auth state
only after verified zero residue. A seed or cleanup failure retains recovery
state when zero residue cannot be proven; rerun the same cleanup command after
correcting the underlying transient failure. Never delete the manifest or auth
file manually while residue may remain.
