-- Migration 057: forced re-consent for agent-scoped OAuth (ADR 0015)
--
-- 056 added the columns. This is the other half of the fix, and it is the half
-- that makes the change take effect for tokens that already exist.
--
-- WHY THIS IS NOT OPTIONAL. Every token issued by Phase 1 carries
-- authorization_mode 'USER' and no agent, so it keeps resolving to
-- purpose "USER" forever: grant-scoped workspace reach bypassed, the three
-- "Human administrator required." assertions bypassed, the 17 AGENT_TOOL_POLICY
-- DENY entries bypassed, no AgentToolCall audit trail. Shipping a consent
-- screen that can finally bind an agent, while deliberately leaving the
-- over-privileged tokens it was written for live, is not a fix.
--
-- Three options were weighed (docs/design/agent-scoped-oauth.md, "Backward
-- compatibility"):
--
--   Grandfather   Zero disruption — and the exact token that exposed the gap
--                 stays over-privileged indefinitely.
--   Downgrade     There is nothing coherently narrower. With no agent_id there
--                 is no grant set, so "narrower" means "no reach", which is
--                 revocation with a worse error message.
--   Re-consent    One re-click, and the gap closes for everyone at once.
--
-- The population is tiny (OAuth shipped 2026-09-18: one Geode install plus test
-- clients) and clients recover on their own — a revoked family makes refresh
-- fail, which surfaces as a re-authorization prompt.
--
-- WHY THE CONSENT ROWS ARE DELETED, NOT UPDATED. hasStoredConsent's successor,
-- findStoredConsent (lib/oauth/consent.ts), short-circuits the authorize page
-- and replays the remembered binding. A backfilled row says
-- authorization_mode 'USER', so leaving it in place would replay the admin
-- override on every reconnect and the new picker would never render for the one
-- person it was built for. Deleting the row is what forces the screen.
--
-- The `__Host-` consent cookie was the other short-circuit, and no migration
-- could ever reach it — which is why it was removed from the application in the
-- same change rather than versioned around. This migration would be ineffective
-- against an already-consented browser without that removal; the two are a pair.
--
-- RERUN SAFETY. Both statements are idempotent in the sense that matters: a
-- second pass revokes nothing new and deletes nothing new. The one window worth
-- naming is that a re-run (after a timed-out POST, say) would also revoke a
-- token and delete a consent created in the minutes between passes. The
-- consequence is one extra trip through the consent screen for whoever
-- authorized inside that window, which is the same outcome this migration is
-- deliberately imposing on everyone else.
--
-- DSQL rules: no DDL here at all, so no ADD COLUMN constraint limits, no ASYNC
-- index, and no per-transaction DDL restriction. Two data statements over
-- tables with tens of rows. Budget one POST.

UPDATE oauth_tokens SET revoked_at = now() WHERE revoked_at IS NULL;

DELETE FROM oauth_consents;

-- A pre-migration code can still mint a new token family after the token
-- revocation above. Removing every short-lived code closes that issuance path;
-- clients simply restart authorization and receive the new binding screen.
DELETE FROM oauth_authorization_codes;
