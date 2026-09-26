# ADR-0017: Explicit Vercel-managed mode for the Docs preview pilot

**Date:** 2026-09-24
**Status:** Accepted for the bounded pilot; implementation and hosted verification required

## Context

Compass consumes the published Geode Headless SDK but needs a hosted synthetic Docs pilot before integrating the preview-only storage path. The existing controller assumes dedicated runtime and migration IAM roles. The available Vercel-managed AWS integration does not provide the custom-role administration needed for that path.

The approved alternative reuses existing infrastructure and accepts application-level schema separation. This is not equivalent to restricting database credentials: managed credentials can retain access to other schemas, including production. Code review and tests reduce that risk but cannot make a permissions-isolation claim true.

## Decision

Add an explicit `vercel-managed` mode for the first-party PR276 pilot, alongside the unchanged scoped-role mode. Fail closed on invalid environment, repository, branch, PR, commit or immutable deployment identity before database use. Derive the schema from trusted deployment metadata; prohibit caller-controlled schema/host/SQL and configuration overrides that could redirect the connection.

Use the deployed migration API with preview authentication, immutable target checks, an owned-schema marker and durable writer claims. Apply only reviewed registered migrations in order. Refuse an existing unowned schema. Inspect partial progress before recovery; no automatic stale-claim takeover or blind retry. Preserve production runner behavior while excluding the exact legacy public-schema creation statement from the managed baseline. Bootstrap only after complete migration and catalog/index readiness.

Bind synthetic sessions, bootstrap and storage to a configured run/workspace pair. Use signed short-lived grants and replay checks; reject convenience-login and ordinary-session bypasses in managed mode. Reuse the existing private preview Blob store with an exact derived prefix. Revoke access at teardown, retaining fixture data, references, receipts and inventory for inspection. Physical cleanup requires separate authorization.

The controller is manual-only. This decision creates no schedules, paid resources or IAM roles. It does not authorize production storage activation or migration of existing document bodies. Production pilot flags remain absent/off when integration code is released.

## Options considered

| Option | Benefit | Cost or limitation |
| --- | --- | --- |
| Dedicated scoped roles | Database-enforced separation; retains the existing controller contract | Requires unavailable IAM administration through the managed integration |
| Explicit managed mode (selected) | Uses the existing integration and migration API; permits bounded hosted verification | Credentials retain broader authority; safety depends on reviewed application routing and mutation guards |
| Defer hosted pilot and integration | No additional live migration exposure | Does not verify the requested SDK integration or advance the release |

## Consequences and risks

- A defect in routing, a migration hook or future SQL can escape application-level boundaries. Review the entire registered baseline, not just059, and reject unexpected schema/global operations.
- DSQL asynchronous indexes and multi-request migrations can leave incomplete state. Durable receipts and index/catalog checks must gate bootstrap; a successful HTTP response alone is insufficient.
- Credentials, grants, browser state and private object locations must not enter logs, screenshots or committed artifacts. Test only synthetic data and keep signing material outside deployments.
- Retention avoids destructive recovery but leaves bounded synthetic rows and objects until explicitly approved cleanup. Export exact inventory; never infer garbage from an absent document row.
- Production release verification is separate from pilot verification. Keep storage disabled in production and verify legacy Docs behavior after the exact reviewed merge.

## Required evidence

Test wrong-target rejection before database access, ownership/collision and interrupted initialization, serialized migrations and partial recovery, all-index readiness, signed-run expiry/replay/revocation, and cross-workspace denial. Run the complete baseline against a local isolated database with unrelated-schema sentinels unchanged. Independently review the final diff. Then verify the exact hosted deployment using synthetic UI and MCP requests with private Blob: create/read/save, identical retry, stale/concurrent revision rejection, preserved history and failed-write state, restore and fresh-context read. Local PostgreSQL is not DSQL proof.

Revisit this decision if dedicated credentials become available, the pilot expands beyond its approved branch/workspace, data stops being synthetic, or the mutation surface can no longer be bounded and reviewed. Do not generalize this exception into the default preview controller.
