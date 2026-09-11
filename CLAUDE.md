# Compass — Project Notes

## Secrets

- **`MIGRATION_SECRET`** (gates `/api/admin/migrate`, the admin DDL-execution endpoint): stored in **1Password** under **"Compass Prod MIGRATION_SECRET"**.
  - `checkAuth()` in the migrate route rejects an empty secret, so if the endpoint 401s unexpectedly, check `vercel env ls production` — the var can silently resolve to an empty string even when it *looks* set.
  - To fix: `vercel env rm MIGRATION_SECRET production` then `vercel env add MIGRATION_SECRET production` (paste the 1Password value, no trailing newline), then **redeploy** — env var changes don't take effect until a fresh deployment.
  - Verify the new value actually stuck by hitting the live endpoint (GET status query) with it — don't trust `vercel env pull`/`env ls` display alone.

- **`REPAIR_SECRET`** (gates `/api/admin/repair-workspace-memberships`, the one-time membership-backfill endpoint): stored in **1Password** under **"Compass Prod REPAIR_SECRET"**.
  - Same trust boundary and same rotate-and-lose-it risk as `MIGRATION_SECRET` — it's a Vercel "sensitive" var, write-only once set.
  - To rotate: `vercel env rm REPAIR_SECRET production` then `vercel env add REPAIR_SECRET production` (paste the 1Password value, no trailing newline), then **redeploy**.
  - Verify without mutating real data: `POST` with a garbage `orgSlug` (e.g. `__verify-probe__`) — a correct secret returns `404 "No org found with slug ..."`; a wrong/stale secret returns `401 Unauthorized`.

**Standing rule for any secret in this project:** the moment you rotate a value in Vercel, save it to 1Password *before* doing anything else with it (before testing, before moving to the next step) — a dropped connection or a session that dies mid-task should never mean losing the value again. If a saved 1Password copy no longer matches what's live in Vercel (write-only vars can't be read back to confirm), treat it as an incident: rotate fresh, save immediately, redeploy, and verify live — don't assume the stale copy might still work.

## Production data migrations

Production schema and data maintenance runs through the registered migrations in `lib/migrations/runner.ts` and the authenticated `/api/admin/migrate` endpoint. Do not run local scripts directly against Aurora DSQL or use an AWS CLI login as an alternate production write path.

For a targeted migration: deploy the registered migration, use authenticated `GET /api/admin/migrate` to confirm the schema, manifest, preflight, and pending state, then `POST /api/admin/migrate` with `{"script":"<exact migration name>"}`. Do not omit `script` when unrelated migrations are pending. Afterward, repeat the status GET and perform application-level readback. A data migration must finish its postconditions before the runner records a successful receipt; reruns must be idempotent and safely resume unfinished work.

In the agent harness, retrieve the production migration credential as `COMPASS_PRODUCTION_MIGRATION_SECRET` and pass it only as the `x-migration-secret` header (for example by assigning it to `MIGRATION_SECRET` in the command environment). Never print it, persist it in a repository file, or substitute direct database credentials when it is unavailable.

## Portal SSO Identify — resyncing a drifted customer secret

A customer's SSO Identify integration signs JWTs with a shared secret that
Compass stores encrypted per-workspace (`Workspace.ssoSecretEncrypted`). That
raw value is shown to the customer **once**, at generation time in
Settings → Portal → SSO Identify — there's no way to look it up again later,
only regenerate.

If a customer reports `"This sign-in link is invalid, expired, or has an
invalid signature"`, and you've confirmed `SSO_SECRET_ENCRYPTION_KEY` decrypts
without throwing (i.e. it's a genuine secret mismatch, not a key/config
issue), use `POST /api/admin/portal-sso-resync` (gated by `MIGRATION_SECRET`,
same trust boundary as `/api/admin/migrate`) to force a fresh value
server-to-server without needing an interactive Settings login:

```bash
curl -s -X POST https://compass.rbcodelabs.com/api/admin/portal-sso-resync \
  -H "x-migration-secret: $MIGRATION_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"orgSlug": "rbcodelabs", "workspaceSlug": "golden-wealth"}'
```

Returns `{ "rawSecret": "..." }` — that response is the only time this value
is ever visible again. Immediately update the customer's stored copy (env
var + password manager) and redeploy their app before the response is gone.
