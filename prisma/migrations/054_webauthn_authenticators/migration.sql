-- Migration 054: WebAuthn authenticators (passkey login)
--
-- Adds the Authenticator table Auth.js's built-in Passkey provider needs.
-- @auth/prisma-adapter already implements createAuthenticator/getAuthenticator/
-- listAuthenticatorsByUserId/updateAuthenticatorCounter against a Prisma model
-- named Authenticator — no adapter code changes required, just this table.
--
-- DSQL rules followed:
--   - UUID PK via gen_random_uuid(), no SERIAL. Own synthetic id, separate
--     from credential_id (the actual WebAuthn credential id from the browser,
--     base64url-encoded, which is what the adapter looks up by).
--   - No FK constraint from authenticators.user_id to users — relationMode
--     = "prisma" already covers the Prisma-side relation for typed queries;
--     DSQL wouldn't enforce it at the DB level anyway.
--   - No @updatedAt — this table is never updated except counter bumps,
--     which the adapter writes explicitly.
--   - Brand-new table, so columns can be NOT NULL freely — the "no NOT NULL
--     on ALTER TABLE ADD COLUMN" DSQL rule only applies to altering existing
--     tables.
--   - Indexes are ASYNC, the only form DSQL supports; the runner rewrites
--     ASYNC away when DATABASE_URL signals local PostgreSQL.

CREATE TABLE IF NOT EXISTS "authenticators" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "credential_id" VARCHAR(512) NOT NULL,
  "user_id" UUID NOT NULL,
  "provider_account_id" VARCHAR(255) NOT NULL,
  "credential_public_key" TEXT NOT NULL,
  "counter" INTEGER NOT NULL,
  "credential_device_type" VARCHAR(50) NOT NULL,
  "credential_backed_up" BOOLEAN NOT NULL,
  "transports" VARCHAR(255),
  "created_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "authenticators_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX ASYNC IF NOT EXISTS "authenticators_credential_id_key" ON "authenticators" ("credential_id");

CREATE INDEX ASYNC IF NOT EXISTS "authenticators_user_id_idx" ON "authenticators" ("user_id");
