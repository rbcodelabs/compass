# Compass — Project Notes

## Secrets

- **`MIGRATION_SECRET`** (gates `/api/admin/migrate`, the admin DDL-execution endpoint): stored in **1Password** under **"Compass Prod MIGRATION_SECRET"**.
  - `checkAuth()` in the migrate route rejects an empty secret, so if the endpoint 401s unexpectedly, check `vercel env ls production` — the var can silently resolve to an empty string even when it *looks* set.
  - To fix: `vercel env rm MIGRATION_SECRET production` then `vercel env add MIGRATION_SECRET production` (paste the 1Password value, no trailing newline), then **redeploy** — env var changes don't take effect until a fresh deployment.
  - Verify the new value actually stuck by hitting the live endpoint (GET status query) with it — don't trust `vercel env pull`/`env ls` display alone.

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
