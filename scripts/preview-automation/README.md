# Authenticated preview validation

## Manual Vercel-managed PR276 pilot

This explicitly risk-accepted mode uses privileged Vercel-managed credentials
with application-enforced schema routing, **not IAM/database-enforced isolation**.
It does not enable the scoped-role workflows below or create cloud resources.

Configure only the PR276 branch preview with `PREVIEW_DATABASE_MODE=vercel-managed`,
`PREVIEW_AUTOMATION_ENABLED=1`, fixed UUIDs `PREVIEW_MANAGED_RUN_ID` and
`PREVIEW_MANAGED_WORKSPACE_ID`, the existing preview `MIGRATION_SECRET`, managed
database settings, and the controller public key. Vercel's first-party repository,
branch, PR, commit, URL and deployment metadata must match. `PGSCHEMA` and
`DATABASE_URL` overrides are forbidden. Production never uses this mode.

The trusted manual driver requires `PREVIEW_DEPLOYMENT_ID`, `PREVIEW_EXPECTED_SHA`,
`PREVIEW_VERCEL_TEAM_ID`, `PREVIEW_VERCEL_PROJECT_ID`, `PREVIEW_VERCEL_TOKEN`,
`GITHUB_TOKEN`, `COMPASS_PREVIEW_MIGRATION_SECRET` and
`COMPASS_VERCEL_BYPASS_SECRET`. Retrieve the preview migration credential from its
system of record; do not assume a harness cache is current. No credentials are printed.

```sh
pnpm exec tsx scripts/preview-automation/managed.ts initialize
pnpm exec tsx scripts/preview-automation/managed.ts status
pnpm exec tsx scripts/preview-automation/managed.ts 001_init
```

Each invocation resolves the immutable deployment through Vercel and GitHub,
checks its exact expected SHA, and targets only that deployment's API. Initialization
uses `{ "action": "initialize" }`; migration requests use only `{ "script": "<exact name>" }`.
Both require `x-migration-secret` and `x-preview-deployment-id`, with the Vercel
protection bypass header on transport. Do not use production credentials or aliases.

After initialization, inspect GET status and advance **only its first pending
migration**. The server enforces order too. A 202 means resumable decision-runner
progress, not completion: inspect status before another explicit invocation of the
same name. There is no automatic POST retry or migration-all command. Wait for all
expected indexes to be valid before synthetic bootstrap; `managed.ready` also
requires ownership, complete059 health, no pending/unresolved migrations and no claim.

An existing schema without matching deployment/commit/run/workspace ownership is
never adopted. An interrupted initialization requires reviewed recovery; do not
delete or take it over automatically. A killed or failed migration keeps a durable
nonexpiring claim, visible as `managed.owner.claimed_by` and `claim_script`.
Stop and inspect receipts, catalog and execution state; this tool deliberately has
no force-unlock or blind-retry command. A handled202 releases the outer claim while
preserving the migration runner's own durable continuation state. Missing indexes
or uncertain outcomes never certify readiness.

Local verification (disposable localhost `compass_e2e` only):
`node --env-file=.env.local --import tsx scripts/verify-managed-pilot-migrations.ts`.
The proof takes the shared E2E advisory lock and checks production-like/shared-preview
sentinel data and catalogs remain unchanged after every migration continuation.
It cleans up only random local schemas it created. Hosted resources are retained.

### Manual managed authentication

After migration status confirms `managed.ready`, use the separate manual auth driver.
It requires the same deployment metadata credentials and `PREVIEW_EXPECTED_SHA`, plus
`PREVIEW_DATABASE_MODE=vercel-managed`, the deployed `PREVIEW_MANAGED_RUN_ID` and
`PREVIEW_MANAGED_WORKSPACE_ID`, controller-only `PREVIEW_AUTOMATION_PRIVATE_KEY`,
and `PREVIEW_PROTECTION_BYPASS` (supply the harness's existing
`COMPASS_VERCEL_BYPASS_SECRET` securely, never in command arguments or logs).
Only the public key belongs in deployed preview configuration.

```sh
pnpm exec tsx scripts/preview-automation/managed-auth.ts bootstrap
pnpm exec tsx scripts/preview-automation/managed-auth.ts session owner
pnpm exec tsx scripts/preview-automation/managed-auth.ts session viewer
pnpm exec tsx scripts/preview-automation/managed-auth.ts revoke
```

Each command freshly resolves the current first-party PR276 immutable READY deployment,
requires the expected full SHA, and sends a fresh short-lived Ed25519 grant for the fixed
run. Requests never follow redirects or automatically retry. After an uncertain bootstrap
or revocation response, inspect run/status evidence before deciding whether to retry.
`revoke` calls managed teardown: sessions are revoked, while schema, rows and Blob
inventory are retained. It does not invoke the scoped-role cleanup workflow.

Session commands emit a sanitized summary and `stateFile` path only. The Playwright
storage-state file is created exclusively with mode0600 inside a fresh private temporary
directory; treat it as a credential. Pass it only to a trusted browser context targeting
the exact returned origin, with bypass headers confined to that origin. Do not upload
or commit it. Remove that exact temporary directory after verification/revocation.
This driver does not launch arbitrary test commands or pass signing keys to child processes.
It does not grant MCP tokens or replace the required hosted storage/UI/MCP verification.

## Scoped-role controller (separate mode)

The controller below remains disabled until its scoped-role infrastructure gates pass.
It never uses the production migration secret or production login credentials.

## Entry points

- `pnpm preview:flow`: trusted local default-branch checkout; validate deployment, register a two-hour lease, provision scoped roles, run target-revision migrations, execute browser checks, revoke the run.
- `pnpm preview:flow --explore`: same lifecycle, then a headed authenticated browser until closed or the run expires (maximum one hour).
- `pnpm preview:flow --explore --scenario=<empty|full-data|mid-okr-cycle>`: seed the run's primary workspace from a fixed server-side catalog before exploring. `empty` (the default, and what every grant without a scenario claim gets) leaves the bare bootstrap fixture unchanged; `full-data` seeds squads, an active OKR cycle, discovery, experiments, roadmap, feedback, tasks, and a doc; `mid-okr-cycle` seeds squads and an active OKR cycle only. The identifier selects among server-defined shapes — requests never supply fixture content — and is verified as a grant claim, so an unknown value fails closed before any database work. Fixtures commit inside the bootstrap transaction and live only in the run's primary workspace, so existing exact-ID teardown already owns them; the isolated workspace stays empty for cross-workspace denial checks. Automated `preview:test` flows are unaffected: they seed the data they assert on and pass no scenario.
- GitHub **Authenticated preview validation**: deployment-success or manual immutable deployment ID, separated provisioning/migration/browser jobs.
- GitHub **Preview recovery**: hourly registered-resource recovery; `pnpm preview:cleanup` is the equivalent trusted manual entry.

Do not invoke `preview:test` as a standalone shortcut. It requires a signed provision receipt with at least 65 minutes remaining (one-hour session plus setup buffer). Provisioning persists the matching lease before issuing the receipt. Cleanup claims expired registry rows atomically, fencing subsequent provisioners; interrupted cleanup can resume after fifteen minutes. Session hard expiry is independent of cleanup.

## Configuration and trust

Controller metadata: `PREVIEW_DEPLOYMENT_ID` (immutable ID or deployment URL), `PREVIEW_VERCEL_TOKEN`, `PREVIEW_VERCEL_PROJECT_ID`, `PREVIEW_VERCEL_TEAM_ID`, `GITHUB_TOKEN`. Only open first-party `rbcodelabs/compass` PRs at their current head SHA are accepted. The resolved Vercel generated URL, never a branch alias, is used for browser traffic.

Database: `PREVIEW_DSQL_HOST`, `AWS_REGION`, `PREVIEW_RUNTIME_IAM_ROLE`, `PREVIEW_MIGRATION_IAM_ROLE`. Local lifecycle additionally uses `PREVIEW_PROVISION_ACCESS_KEY_ID` / `PREVIEW_PROVISION_SECRET_ACCESS_KEY` and `PREVIEW_MIGRATION_ACCESS_KEY_ID` / `PREVIEW_MIGRATION_SECRET_ACCESS_KEY`; optional corresponding `*_SESSION_TOKEN` values support temporary credentials. Do not supply credentials with production access to the migration worker or deployed preview.

Authentication: Ed25519 PEM `PREVIEW_AUTOMATION_PRIVATE_KEY` is controller-only; matching `PREVIEW_AUTOMATION_PUBLIC_KEY` is the only signing material placed in previews. `PREVIEW_PROTECTION_BYPASS` is registered in Vercel deployment protection. It grants network reachability, not product authentication.

GitHub uses the same named variables/secrets shown in the workflow files, with `PREVIEW_AWS_REGION` as repository variable. Configure `preview-provisioning`, `preview-migrations`, and `preview-tests` environments with deployment branch restrictions allowing **main only**. Store every preview API credential, AWS credential, signing key, and bypass secret exclusively in those protected environments, never as repository-wide secrets accessible to PR YAML. Enable repository variable `PREVIEW_AUTOMATION_ENABLED=1` only after a successful manual run. The workflow source and privileged dependencies must be reviewed on `main` before enabling.

`deployment_status` runs the deployed revision's workflow, so it is only an unprivileged relay: no environment, no secrets, no checkout. It uploads a tiny deployment hint. The privileged `workflow_run` controller comes from default-branch YAML, checks successful first-party relay provenance, reads the artifact as untrusted data, then independently verifies Vercel/GitHub identities. Relay artifacts never supply executable code, checkout refs, or caches. Manual dispatch and recovery are also restricted to main. The controller publishes pending/final `compass/preview-validation` commit status on the validated PR SHA; it does not change branch protection.

Each opted-in Vercel revision needs branch-specific `PREVIEW_AUTOMATION_ENABLED=1`, a valid PR/SHA in Vercel Git metadata, preview-only `AWS_ROLE_ARN`, `PGHOST`, and the public key. Runtime derives `compass_pr_<PR>_<sha12>_runtime` from verified metadata; no per-commit PGUSER change is needed. Do not overwrite current shared Production/Preview variables. Provisioning and credentials configuration precede the manual preview activation/redeploy. This controller does not modify Vercel environment variables. A deployment created before the PR exists fails closed and must be redeployed once PR metadata is available.

## Rollout gates and limitations

1. `preview:probe` must prove preview IAM roles cannot connect as admin or access production schemas before browser bootstrap. It uses `PREVIEW_RUNTIME_ACCESS_KEY_ID` / `PREVIEW_RUNTIME_SECRET_ACCESS_KEY` (optional session token) in local lifecycle and corresponding GitHub secrets. SQL role names alone are not a security boundary.
2. Run provisioning, scoped migrations, async-index readiness, browser flows, and recovery on DSQL. Local mock/unit tests cannot establish DSQL permissions or IAM grants.
3. Exercise concurrent provisioning/cleanup and interrupted cleanup against the real database before automatic activation.
4. Merge the dark-mode feature from PR156 before expecting appearance checks to pass; they intentionally fail when the required control is absent.
5. Review the existing owner/member authorization behavior; the historical `viewer` fixture persona is a MEMBER, not a nonexistent read-only role.

Target-revision migration code receives only dedicated preview migration credentials. First-party PRs are trusted code: this is not a sandbox for hostile code. The existing migration runner is reused, with schema creation suppressed in the pre-provisioned worker path. No production route is invoked by the controller.

Only `preview-report/summary.json` and explicit synthetic-workspace screenshots are retained for seven days. Browser storage state lives in a mode-0600 temporary directory, removed in `finally`; raw traces/video are disabled. Grants, signing keys, API credentials, and storage state must never be added to artifacts. Real Google/Resend delivery, external integrations, and production data are outside this suite.

## Local verification — 2026-09-06

Implementation verification results (not approval to activate):

| Check | Result |
| --- | --- |
| `pnpm test` | Exit 0: 2,328 passed, 7 intentionally skipped; 210 files passed, 1 skipped. |
| Opt-in PostgreSQL integration | Separately executed: 7/7 passed. Covers nonce concurrency, transactional rollback, run isolation, exact cleanup, session expiry, and teardown races. This does not establish DSQL/IAM behavior. |
| Nonincremental TypeScript | Exit 0. |
| `pnpm lint` | 0 errors, 30 warnings. |
| UI color and primitive guards | Both passed. |
| `pnpm build` | Exit 0. |
| `git diff --check` | Clean. |
| Existing functional browser suite | Exit 1 with the five failures below; not a green E2E gate. Cleanup verified 0 fixture organizations and 1 retained sentinel. |
| New deployed-preview browser suite | 18 tests collected across desktop, tablet, and mobile; **not executed** against a deployed preview. |

Existing functional failures observed, without unrelated fixes:

- `capture-research.spec.ts:29`: follow-up question absent after five seconds; UI remained “preparing the next question.”
- `building-investment-decision.spec.ts:98`: expected “Building investment review”; rendered “Legacy system decision · Building investment.”
- `feedback-grid.spec.ts:255`: “In progress” remained checked after attempted deselection.
- `feedback-bug-roadmap.spec.ts:80`: timed out waiting for the absent “Bugs” button.
- `now-decision-gate.spec.ts:29`: timed out waiting for “Request NOW commitment”; rendered “Request decision” instead.

Actual DSQL permissions, IAM bindings, and deployed provisioning/recovery remain unverified because the AWS session was expired. PR156 remains an appearance-test prerequisite. No production or environment activation was performed; automatic validation must remain disabled until the rollout gates above are satisfied.
