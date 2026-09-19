@AGENTS.md

# Compass — Project Notes

## Architecture decisions live in Compass, not the repo

**Compass Docs is the authoritative home for Compass ADRs.** They sit under the
[**Architecture Decisions**](https://compass.rbcodelabs.com/rbcodelabs/compass/docs/57218788-1db1-4148-b954-b98fb7055c62)
parent doc in the `rbcodelabs/compass` workspace. This is what
`Products/Compass/pm-config.md` already routes to — both `review_requests` and
`decision_records` resolve to the `compass_decisions` provider.

- **To record a new architecture decision:** create a child Doc under that
  parent, then route it for approval with `request_decision` using
  `subjectType: "DOC"`.
- **Never self-certify.** Do not write `Status: Accepted` on your own record.
  Approval is an event that comes back from the provider; if it did not come
  back, the decision is not approved.
- **`docs/decisions/` holds pointer stubs only.** The 16 historical ADRs were
  migrated to Compass on 2026-09-19; the files remain as stubs solely so the
  ~85 existing references across the codebase keep resolving. **Do not add new
  files to that directory**, and do not expand a stub back into a full record.

## Secrets

- **`MIGRATION_SECRET`** (gates `/api/admin/migrate`, the admin DDL-execution endpoint): stored in **1Password** under **"Compass Prod MIGRATION_SECRET"**.
  - `checkAuth()` in the migrate route rejects an empty secret, so if the endpoint 401s unexpectedly, check `vercel env ls production` — the var can silently resolve to an empty string even when it *looks* set.
  - To fix: `vercel env rm MIGRATION_SECRET production` then `vercel env add MIGRATION_SECRET production` (paste the 1Password value, no trailing newline), then **redeploy** — env var changes don't take effect until a fresh deployment.
  - Verify the new value actually stuck by hitting the live endpoint (GET status query) with it — don't trust `vercel env pull`/`env ls` display alone.

- **`REPAIR_SECRET`** (gates `/api/admin/repair-workspace-memberships`, the one-time membership-backfill endpoint): stored in **1Password** under **"Compass Prod REPAIR_SECRET"**.
  - Same trust boundary and same rotate-and-lose-it risk as `MIGRATION_SECRET` — it's a Vercel "sensitive" var, write-only once set.
  - To rotate: `vercel env rm REPAIR_SECRET production` then `vercel env add REPAIR_SECRET production` (paste the 1Password value, no trailing newline), then **redeploy**.
  - Verify without mutating real data: `POST` with a garbage `orgSlug` (e.g. `__verify-probe__`) — a correct secret returns `404 "No org found with slug ..."`; a wrong/stale secret returns `401 Unauthorized`.

- **`COMPASS_VERCEL_BYPASS_SECRET`** — Vercel Deployment Protection bypass for this project's `*.vercel.app` preview and production URLs. **Read it from the agent-harness env var; do not go looking for it in 1Password.**
  - Pass as the header `x-vercel-protection-bypass: $COMPASS_VERCEL_BYPASS_SECRET`. Without it, preview URLs answer **302 → `vercel.com/sso-api`** and nothing else works.
  - It clears *Vercel's* SSO gate only — it is **not** app auth. NextAuth login is still required for any authenticated page.
  - Unlike the secrets above, this one is not consumed by the app at runtime, so there is nothing to redeploy after changing it.

**Standing rule for any secret in this project:** the moment you rotate a value in Vercel, save it to 1Password *before* doing anything else with it (before testing, before moving to the next step) — a dropped connection or a session that dies mid-task should never mean losing the value again. If a saved 1Password copy no longer matches what's live in Vercel (write-only vars can't be read back to confirm), treat it as an incident: rotate fresh, save immediately, redeploy, and verify live — don't assume the stale copy might still work.

### Reading a secret: the only correct order

This ordering is about the **app-consumed** secrets above (`MIGRATION_SECRET`, `REPAIR_SECRET`). It does **not** apply to `COMPASS_VERCEL_BYPASS_SECRET`, which is read straight from the harness env var — see its entry above.

Vercel env values are **write-only**. `vercel env pull` and `vercel env ls` will happily return a var as present-but-blank, and that tells you **nothing** about the value the running deployment actually has.

1. **1Password is the system of record. Look there FIRST.** `op item list | grep -i compass` — the items are named `Compass Prod MIGRATION_SECRET`, `Compass Preview MIGRATION_SECRET`, `Compass Prod REPAIR_SECRET`, etc. There is a **preview** secret as well as a prod one; don't assume only prod exists.
2. **Agent-harness env vars (`COMPASS_*_MIGRATION_SECRET`) are a convenience cache, not the source of truth.** They go stale. If one 401s, the harness value is wrong — that is the *likely* explanation, not an infrastructure fault.
3. **Verify a secret only by using it against the live endpoint** (authenticated `GET /api/admin/migrate`). Never by comparing pulled values or hashes.
4. **Never propose rotating a secret until you have confirmed 1Password does not already hold a working value.** Rotation is destructive and needs a redeploy; it is close to never the right first move.

**Forbidden inference — this has already cost a session:** a blank/0-char value from `vercel env pull` is **not** evidence that the deployment's var is empty, and therefore **not** an explanation for a `401`. Concluding "the var is an empty string, so `checkAuth()` rejects everything" from pulled output is a fabricated diagnosis. The real cause of a `401` is almost always that *you* sent the wrong value. Go to 1Password and retry before theorising about infrastructure, and never propose an env-var rotation or a redeploy on the strength of a pulled blank.

Related: when checking whether a migration is applied, compare **exact names**, never substrings. `"051" in name` matches `051_pm_agent_handoff` as readily as `051_decision_task_bridge`. Note also that duplicate leading numbers are normal and accepted here (`main` carries two `049_*` migrations) because the runner keys on the exact name — a collision is not a bug to "fix", and branch previews share one `compass_preview` schema, so its applied list routinely contains migrations from branches other than yours.

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
