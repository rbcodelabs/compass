# Authenticated preview validation

This controller is deliberately disabled until its infrastructure gates pass. It never uses the production migration secret or production login credentials.

## Entry points

- `pnpm preview:flow`: trusted local default-branch checkout; validate deployment, register a two-hour lease, provision scoped roles, run target-revision migrations, execute browser checks, revoke the run.
- `pnpm preview:flow --explore`: same lifecycle, then a headed authenticated browser until closed or the run expires (maximum one hour).
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
