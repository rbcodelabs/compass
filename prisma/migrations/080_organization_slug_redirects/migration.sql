-- Migration 080: organization slug history.
-- Additive: one new table and one unique async index. No existing table changes and
-- no backfill (an organization that has never been renamed has no history).
--
-- Aurora DSQL rules followed:
--   - No foreign keys: organization_id is a bare UUID column, maintained in application
--     code (organization deletion removes these rows explicitly).
--   - One DDL statement per statement, each idempotent (IF NOT EXISTS).
--   - The index is CREATE UNIQUE INDEX ASYNC, with no ASC/DESC and no partial index.
--   - No trigger and no updated_at: rows are insert-only (a rename back to a retired
--     slug deletes the row rather than updating it).
--
-- A row means "organizations.slug used to be old_slug". The row stores the organization
-- id, not the new slug, so a chain of renames (a -> b -> c) always resolves to the
-- organization's CURRENT slug. old_slug is globally unique: a retired slug is reserved
-- for the organization that held it and cannot be claimed by another organization.

CREATE TABLE IF NOT EXISTS organization_slug_redirects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  old_slug VARCHAR(255) NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX ASYNC IF NOT EXISTS idx_organization_slug_redirects_old_slug ON organization_slug_redirects(old_slug);
