# Compass — Project Notes

## Secrets

- **`MIGRATION_SECRET`** (gates `/api/admin/migrate`, the admin DDL-execution endpoint): stored in **1Password** under **"Compass Prod MIGRATION_SECRET"**.
  - `checkAuth()` in the migrate route rejects an empty secret, so if the endpoint 401s unexpectedly, check `vercel env ls production` — the var can silently resolve to an empty string even when it *looks* set.
  - To fix: `vercel env rm MIGRATION_SECRET production` then `vercel env add MIGRATION_SECRET production` (paste the 1Password value, no trailing newline), then **redeploy** — env var changes don't take effect until a fresh deployment.
  - Verify the new value actually stuck by hitting the live endpoint (GET status query) with it — don't trust `vercel env pull`/`env ls` display alone.
