CREATE TABLE IF NOT EXISTS "api_keys" (
  "id"           UUID        NOT NULL DEFAULT gen_random_uuid(),
  "user_id"      UUID        NOT NULL,
  "name"         VARCHAR(255) NOT NULL,
  "key_hash"     VARCHAR(64) NOT NULL,
  "key_prefix"   VARCHAR(8)  NOT NULL,
  "last_used_at" TIMESTAMP(3),
  "revoked_at"   TIMESTAMP(3),
  "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "api_keys_key_hash_key" UNIQUE ("key_hash")
);

CREATE INDEX ASYNC IF NOT EXISTS "idx_api_keys_key_prefix" ON "api_keys" ("key_prefix");
CREATE INDEX ASYNC IF NOT EXISTS "idx_api_keys_user_id" ON "api_keys" ("user_id");
