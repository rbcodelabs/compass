-- Custom Field Definitions: one row per field template per workspace+objectType
CREATE TABLE "custom_field_definitions" (
    "id"          UUID         NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID        NOT NULL,
    "object_type"  VARCHAR(50) NOT NULL,
    "name"         VARCHAR(255) NOT NULL,
    "field_type"   VARCHAR(50) NOT NULL,
    "options"      JSONB,
    "required"     BOOLEAN     NOT NULL DEFAULT FALSE,
    "order"        INTEGER     NOT NULL DEFAULT 0,
    "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "custom_field_definitions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX ASYNC ON "custom_field_definitions" ("workspace_id", "object_type");

-- Custom Field Values: one row per (field, object) pair
CREATE TABLE "custom_field_values" (
    "id"         UUID NOT NULL DEFAULT gen_random_uuid(),
    "field_id"   UUID NOT NULL,
    "object_id"  UUID NOT NULL,
    "value"      JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "custom_field_values_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "custom_field_values_field_id_object_id_key" UNIQUE ("field_id", "object_id")
);

CREATE INDEX ASYNC ON "custom_field_values" ("field_id");
CREATE INDEX ASYNC ON "custom_field_values" ("object_id");
