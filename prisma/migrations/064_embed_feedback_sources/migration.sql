-- Embedded prototype/application feedback: sources, rotatable tokens, and the
-- two element-anchor extension tables. Purely additive — no existing column
-- changes type or nullability, and no existing row is rewritten.
--
-- Aurora DSQL: no foreign keys (relationMode="prisma", application-scoped
-- integrity), one DDL per statement, and every index is built with
-- CREATE INDEX ASYNC. There is deliberately no ASC/DESC on any index column —
-- DSQL's CREATE INDEX grammar has none.

CREATE TABLE IF NOT EXISTS "feedback_sources" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "workspace_id" UUID NOT NULL,
  -- NULL = real application (submissions become feedback rows).
  -- Set = Artifact-backed prototype (submissions become comments).
  "artifact_id" UUID,
  "name" VARCHAR(255) NOT NULL,
  -- JSON array of exact origins. Never a pattern, never '*'.
  "allowed_origins" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_by_id" UUID,
  -- Which identity this source accepts from a commenter: 'INTERNAL_SSO' (a
  -- Compass SSO user who is a member of the owning workspace) or 'PORTAL' (a
  -- verified PortalAccount, reached by an emailed magic link).
  --
  -- Nullable and carrying no DEFAULT even though this is a CREATE TABLE, where
  -- DSQL would allow one. DSQL forbids ADD COLUMN from carrying any constraint
  -- and counts DEFAULT as one, so a schema that gains this column after the fact
  -- can only get it as a bare nullable add. Declaring a DEFAULT here would leave
  -- that schema disagreeing with this one about the column's shape, so instead
  -- both paths produce the same nullable column and null is read as
  -- 'INTERNAL_SSO' in one place in the application layer — resolveEmbedAuthMode
  -- in lib/embed-auth-mode.ts, which is also where the argument for that default
  -- lives. Same split as artifact_feedback_public below.
  "auth_mode" VARCHAR(20)
);

-- expires_at is nullable on purpose, matching api_keys.expires_at. A deployed
-- site's embed token has no natural expiry; revocation is the kill switch.
CREATE TABLE IF NOT EXISTS "feedback_source_tokens" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "feedback_source_id" UUID NOT NULL,
  "token_hash" VARCHAR(64) NOT NULL,
  "token_prefix" VARCHAR(16) NOT NULL,
  "label" VARCHAR(255),
  "expires_at" TIMESTAMP(3),
  "revoked_at" TIMESTAMP(3),
  "last_used_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_by_id" UUID,
  -- Compare-and-set rate-limit counters, same shape as research_sessions.
  "read_window_at" TIMESTAMP(3),
  "read_count" INTEGER,
  "submit_window_at" TIMESTAMP(3),
  "submit_count" INTEGER
);

CREATE TABLE IF NOT EXISTS "comment_element_anchors" (
  "comment_id" UUID NOT NULL PRIMARY KEY,
  -- Non-null by construction: written only for targetType=ARTIFACT comments,
  -- always equal to the parent comment's target_id.
  "artifact_id" UUID NOT NULL,
  "artifact_revision_id" UUID,
  "page_url" TEXT NOT NULL,
  "page_path" TEXT NOT NULL,
  "element_selector" TEXT,
  "element_fingerprint" JSONB,
  -- A Vercel Blob URL for the element screenshot the widget captured, or null.
  -- Purely an aid for a human reading the thread later ("what did they actually
  -- click"); nothing re-anchors from it. Capture is best-effort in the widget, so
  -- the overwhelmingly common case for internal review comments is null.
  "screenshot_url" TEXT
);

-- Created now, written in a later phase (the unbound/real-application path).
-- Separate from comment_element_anchors because a feedback row has no artifact.
CREATE TABLE IF NOT EXISTS "feedback_element_anchors" (
  "feedback_item_id" UUID NOT NULL PRIMARY KEY,
  "feedback_source_id" UUID NOT NULL,
  "page_url" TEXT NOT NULL,
  "page_path" TEXT NOT NULL,
  "element_selector" TEXT,
  "element_fingerprint" JSONB,
  -- Same column as on comment_element_anchors, so the two anchor shapes stay
  -- interchangeable when the unbound path starts writing here.
  "screenshot_url" TEXT
);

-- Identity for a comment whose author is not a Compass user, so author_id on
-- comments can stay a User reference and stay null for outside submitters.
CREATE TABLE IF NOT EXISTS "comment_external_authors" (
  "comment_id" UUID NOT NULL PRIMARY KEY,
  "submitter_email" VARCHAR(255),
  "portal_account_id" UUID,
  "embed_token_id" UUID,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- DSQL rejects ADD COLUMN carrying any constraint, and it counts DEFAULT as one:
-- `ADD COLUMN ... BOOLEAN DEFAULT false` fails with "ALTER TABLE ADD COLUMN with
-- constraint not supported". Add the column nullable, then backfill existing rows
-- to an explicit false so no workspace is left NULL. Prisma's @default(false) on
-- Workspace.artifactFeedbackPublic applies at the ORM layer for new create()
-- calls only — it is not DDL. Same pattern as 013_portal_auth and
-- 055_workspace_launch_workflow_flag.
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "artifact_feedback_public" BOOLEAN;
UPDATE "workspaces" SET "artifact_feedback_public" = false WHERE "artifact_feedback_public" IS NULL;

CREATE INDEX ASYNC IF NOT EXISTS "idx_feedback_sources_workspace" ON "feedback_sources" ("workspace_id", "enabled");
CREATE INDEX ASYNC IF NOT EXISTS "idx_feedback_sources_artifact" ON "feedback_sources" ("artifact_id");
CREATE UNIQUE INDEX ASYNC IF NOT EXISTS "idx_feedback_source_tokens_hash" ON "feedback_source_tokens" ("token_hash");
CREATE INDEX ASYNC IF NOT EXISTS "idx_feedback_source_tokens_source" ON "feedback_source_tokens" ("feedback_source_id", "revoked_at");
CREATE INDEX ASYNC IF NOT EXISTS "idx_comment_element_anchors_artifact_page" ON "comment_element_anchors" ("artifact_id", "page_url");
CREATE INDEX ASYNC IF NOT EXISTS "idx_feedback_element_anchors_source_page" ON "feedback_element_anchors" ("feedback_source_id", "page_url");
CREATE INDEX ASYNC IF NOT EXISTS "idx_comment_external_authors_account" ON "comment_external_authors" ("portal_account_id");

-- ── Widget visitor identity ───────────────────────────────────────────────────
--
-- A visitor who leaves anchored feedback from a prototype must present a verified
-- identity, but the widget runs on an origin Compass does not serve and neither
-- portal_sessions.token nor the Compass SSO session cookie travels as anything but
-- SameSite=Lax. The obvious shortcut — hand the widget one of those session tokens
-- as a bearer — would give the prototype's JavaScript a credential that also
-- authenticates that person to the rest of the product. So the widget gets its own
-- credential instead: scoped to ONE feedback source, short-lived, and useless
-- anywhere else.
--
-- Two kinds of identity can back one, and EXACTLY ONE of the two columns below is
-- ever set:
--
--   * portal_account_id — an external reviewer, verified by magic link. The
--     original case, and the only one that existed first.
--   * user_id — an internal Compass user signed in through SSO who is a member of
--     the workspace owning the source. Their comments become first-class Comment
--     rows with a real author_id rather than an external-author shim.
--
-- Both are nullable because of that "exactly one", and the invariant is enforced in
-- the application layer (lib/embed-visitor.ts), not here: DSQL has no foreign keys
-- under relationMode="prisma", so there is no CHECK or FK to hang it on, and a
-- NOT NULL on either column would forbid the other kind of identity outright.
CREATE TABLE IF NOT EXISTS "embed_visitor_sessions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  -- Scope. A session minted for one source must not authorize another, even for
  -- the same account, so this is checked against the presented embed token.
  "feedback_source_id" UUID NOT NULL,
  -- Exactly one of portal_account_id / user_id is set. See above.
  "portal_account_id" UUID,
  "user_id" UUID,
  -- SHA-256 only, same as portal_sessions and feedback_source_tokens.
  "token_hash" VARCHAR(64) NOT NULL,
  -- NOT NULL, unlike feedback_source_tokens.expires_at. That column is nullable
  -- because a deployed site's embed token has no natural expiry; this one is the
  -- opposite case — it lives in a third party's page, so it must die on its own.
  "expires_at" TIMESTAMP(3) NOT NULL,
  "revoked_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_used_at" TIMESTAMP(3)
);

-- Server-brokered sign-in handoff: how a credential crosses from the first-party
-- popup (which has the portal cookie) to the widget (which cannot receive it).
--
-- Deliberately stores NOTHING CLAIMABLE. The deposit step records only that this
-- nonce entitles its bearer to a session for this account and this source; the
-- claim step mints the token and returns it once. A reader of this table — a
-- backup, a log, a support query — therefore gains nothing, which is not true of
-- the design this is ported from, where deposit persisted the raw token for the
-- length of the handoff window.
CREATE TABLE IF NOT EXISTS "embed_auth_handoffs" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  -- Knowledge of the nonce is the credential, so only its digest is stored.
  "nonce_hash" VARCHAR(64) NOT NULL,
  "feedback_source_id" UUID NOT NULL,
  -- Exactly one of these two is set, carrying whichever identity the popup
  -- established — same invariant, same enforcement point, and for the same
  -- reasons as on embed_visitor_sessions above.
  "portal_account_id" UUID,
  "user_id" UUID,
  -- Two minutes. Long enough to finish a magic-link login in a popup, short
  -- enough that an unclaimed row is not a standing liability.
  "expires_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX ASYNC IF NOT EXISTS "idx_embed_visitor_sessions_hash" ON "embed_visitor_sessions" ("token_hash");
-- No user_id counterpart to this one, deliberately. Every lookup in the resolve
-- path is by token_hash; this index exists for administrative "which sessions
-- exist for this account" queries, and a second index carrying no query would
-- only cost write throughput.
CREATE INDEX ASYNC IF NOT EXISTS "idx_embed_visitor_sessions_scope" ON "embed_visitor_sessions" ("feedback_source_id", "portal_account_id");
CREATE UNIQUE INDEX ASYNC IF NOT EXISTS "idx_embed_auth_handoffs_nonce" ON "embed_auth_handoffs" ("nonce_hash");
CREATE INDEX ASYNC IF NOT EXISTS "idx_embed_auth_handoffs_expiry" ON "embed_auth_handoffs" ("expires_at");
