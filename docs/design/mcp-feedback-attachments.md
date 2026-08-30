# MCP Feedback Attachments and Canonical URLs

**Status:** Approved
**Date:** 2026-08-30

## Spec

**Approach:** Extend the existing feedback MCP tools with inline screenshot uploads, a signed direct-upload flow for larger files, editable feedback text, and canonical UI URLs.

**Files affected:** `app/api/mcp/route.ts`, `lib/feedback-tool-handlers.ts`, `lib/mcp-tool-gates.ts`, shared feedback attachment/URL helpers, feedback MCP and portal tests, and `docs/content/09-mcp-api.md`.

**Key decisions:**

- `create_feedback` accepts one to five inline attachments. The decoded aggregate is capped at 3 MiB per call and encoded lengths are checked before decoding.
- Inline uploads are all-or-nothing from the caller's perspective. Uploaded blobs are deleted on a later upload or database failure where possible.
- `prepare_feedback_attachment_upload` issues a short-lived Vercel Blob client token plus a signed workspace receipt for files up to 10 MiB.
- `add_feedback_attachment` accepts either inline file data or a completed direct upload. Direct uploads are attached only after the signed receipt and the Blob service's metadata agree. Preparation generates the attachment UUID and signs it into the receipt, so replay races converge on one primary key; same-feedback completion is idempotent and cross-feedback reuse is rejected.
- Attachment additions touch the parent feedback row before counting and creating. Local PostgreSQL serializes the row update; Aurora DSQL detects concurrent writers through OCC and returns retryable SQLSTATE `40001`. The transaction enforces the five-attachment maximum without a schema migration.
- Inside that transaction, completion checks both the deterministic receipt ID and verified Blob URL, preserving ownership of portal/legacy rows. The deterministic ID closes concurrent MCP receipt replay; portal writes do not participate in the parent-touch protocol, so a simultaneous portal/MCP arbitrary-metadata race remains advisory without a schema uniqueness constraint.
- Feedback and attachment UUIDs are generated before writes. On an ambiguous database error, Compass reads by that UUID before deciding whether the write committed; Blob cleanup happens only after confirming no row references it.
- `update_feedback` changes title and/or description. At least one field is required; `description: null` clears it.
- Feedback responses include an absolute canonical URL using authorized organization/workspace slugs and a base URL derived from trusted deployment configuration. Preview deployments prefer `VERCEL_BRANCH_URL`, then `VERCEL_URL`, so records written to preview databases link back to that preview; production continues to use the configured custom domain/production host.
- The current shared feedback statuses are authoritative. Legacy `CLOSED` remains temporarily accepted and is written unchanged for backward compatibility.

**Riskiest assumption:** Agents that need files larger than the inline limit can perform the direct HTTP upload using the returned client token before calling the completion tool.

**Out of scope:** UI changes, schema migrations, a generic asset service, retroactive normalization of legacy feedback statuses, and production deployment.

**Done when:** Unit tests cover attachment validation, rollback, signed receipt verification/idempotency, text updates, authorization gates, status compatibility, and canonical URLs; documentation is current; type-check, full unit suite, build, and functional E2E pass.
