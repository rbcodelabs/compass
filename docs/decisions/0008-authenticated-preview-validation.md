# ADR-0008: Authenticated Preview Validation

**Date:** 2026-09-06
**Status:** Accepted design; activation requires the verification gates below

## Context

Compass needs repeatable authenticated user-flow checks against the exact Vercel deployment under review, both in CI and during agent exploration. The local E2E harness deliberately assumes localhost and a disposable PostgreSQL database; its credentials provider, shared fixtures, and cleanup are not safe deployment automation interfaces. Normal deployed authentication uses Auth.js database sessions with Google and Resend.

Today preview deployments share a schema, and the DSQL client requests an administrative token. A naming convention does not provide database authorization. Auth.js also refreshes database sessions: simply creating a session that expires in one hour does not enforce an absolute one-hour lifetime.

The approved scope is synthetic product-flow validation, not OAuth/email-delivery testing, malicious-code sandboxing, production-data replication, or external integration testing. No new application dependency is required.

## Decision

Use a trusted controller, deployment-bound signed grants, an explicitly enabled preview-only bootstrap interface, and an isolated schema for each PR revision. The same runner supports CI and on-demand use. Existing production and local development login behavior remains unchanged.

### Identity and authorization boundaries

The controller validates repository, open PR, current head SHA, Vercel project, deployment ID, immutable HTTPS origin, and successful deployment state before issuing grants. Branch aliases are not identities. Forks, mismatched projects, superseded revisions, and ambiguous metadata fail closed. Schema identifiers are derived from validated numeric PR and commit SHA as `compass_pr_<number>_<sha12>`; request data cannot override a schema.

Three credential boundaries must remain distinct:

| Actor | Allowed | Forbidden |
|---|---|---|
| Trusted provisioner | Create registered preview schemas and scoped roles; record lifecycle ownership | Execute PR code, dynamic imports, package hooks, or migrations with administrator credentials |
| Migration worker | Apply target-revision DDL in its assigned schema; inspect and resume its migrations | Production access, role administration, other preview schemas |
| Preview runtime | Read/write application and automation records through its revision's `<schema>_runtime` role; application resolves its exact revision schema | Administrative token, schema DDL, production or other real-data schema access |

DSQL runtime connections use non-administrative authentication and the explicit SQL role `<schema>_runtime`, with DML permissions limited to that schema. A shared preview IAM identity mapped only to registered synthetic preview runtime roles is sufficient for the approved trusted-first-party-PR model: revision resolution and run ownership prevent normal tests from colliding, while SQL permissions deny production access. This is logical isolation between previews, not an adversarial sibling-preview boundary. An IAM identity mapped to several SQL roles can select those roles; changing `PGUSER` is not a security boundary. Do not assume Vercel project/environment OIDC trust provides deployment-specific identity. If testing untrusted code is required later, introduce stronger identity isolation as a separate decision rather than claiming these schemas provide it.

Administrative keys and the grant signing key stay in trusted orchestration. A preview receives only its scoped runtime credentials and the grant verification key. Provisioning never uses the existing production migration secret. Migration extraction preserves the existing manifest, applied-migration tracking, asynchronous-index status, and resume behavior; HTTP 202 is pending work, not readiness.

### Run and authentication contract

All bootstrap, session issuance, and teardown entry points require both `VERCEL_ENV=preview` and an explicit automation enable flag. Disabled or production entry points return 404 before database access. Only those exact paths are public to the normal session middleware; each authenticates its own signed operation grant.

A signed grant binds its version, issuer/audience, deployment ID, immutable origin, run UUID, operation, nonce, issued time, and expiry. Keep grants short-lived (at most five minutes). Verification rejects invalid signatures, malformed or oversized fields, unsupported algorithms, wrong operations/deployments, and expired grants. Nonces are consumed atomically with the authorized mutation using a unique key; concurrent replay has at most one winner. Retrying a lost response uses a fresh grant for the same run, never replays the old grant.

The run registry records deployment/revision identity, exact created organization/workspace/persona IDs, creation time, absolute expiry, and revocation/cleanup state. The server generates synthetic identities and fixed owner/viewer personas. Neither arbitrary account identifiers nor arbitrary roles are accepted. Bootstrap is idempotent by run ID and rejects a differing deployment binding. Partial bootstrap is either rolled back or remains registered for recovery.

Session issuance associates an opaque Auth.js database session with that run and persona, then sets the normal secure, HTTP-only, same-site-lax, host-only session cookie. A shared cookie contract prevents drift from Auth.js configuration; no raw session token appears in report output or navigation URLs. Session expiry is no later than the run's creation time plus 60 minutes.

The adapter checks the association on session retrieval and rejects expired, revoked, missing-run, or wrong-deployment automation sessions. Updates cannot extend expiry past the run deadline. Teardown revokes access before deleting fixture data. Ordinary sessions retain their existing behavior. Association deletion must not turn an automation session into an ordinary session: delete sessions first, retain invalidation state until no associated session remains, and test the failure paths.

### Browser execution and recovery

Provisioning serializes by schema; independent runs use different synthetic tenants. The browser runner receives only the validated immutable origin and run-owned personas. It does not weaken local E2E guards or reuse local blanket cleanup. Inject the Vercel bypass header only on the validated origin, never on cross-origin requests or redirects. Authentication capture is outside tracing; storage state is temporary, ignored, permission-restricted, and never uploaded.

Initial flows cover authenticated navigation, opportunity/solution/task mutations and persistence, owner/viewer permissions, cross-workspace denial, and theme/responsive behavior where available in the tested revision. Tests must report unsupported revision features explicitly rather than masking failures. External side effects and real product workspaces remain out of scope.

Every exit attempts teardown using exact registry-owned IDs, with an hourly recovery job for expired runs. DSQL has no foreign-key cascades, so deletion order must be explicit and tested against all seeded relationships. A partially failed teardown remains recoverable and visible. Schema cleanup acts only on controller-registered schemas, after PR closure or seven days of inactivity, and only with no live runs. Never infer ownership from a slug prefix or enumerate-and-drop matching schemas.

Keep sanitized reports and screenshots for seven days. Do not upload raw browser state, grant payloads, authorization headers, or unsanitized traces. Cleanup failure is part of the result, not a successful silent fallback.

## Options Considered

| Option | Benefits | Costs / reasons not selected |
|---|---|---|
| Dedicated mailbox with real magic-link login | Tests actual email delivery and normal callback | Mailbox credentials, delivery latency, and provider availability become test dependencies |
| Restricted preview issuer and run registry (selected) | Deterministic, disposable identities; shared CI/agent runner; bounded lifetime | Adds a security-sensitive preview interface; does not validate Google or email delivery |
| Reusable storage-state secret | Small initial implementation | Host-bound, expires unpredictably, shared identity and long-lived secret distribution |
| Shared preview schema with run-owned tenants | Low provisioning effort | Incompatible PR migrations still collide |
| Per-PR revision schemas on existing cluster (selected) | Stable code/schema pairing without a separate cluster per revision | Requires scoped permissions, lifecycle automation, and explicit infrastructure verification |

## Consequences

Test failures become attributable to one deployed SHA and disposable dataset. A new revision cannot upgrade an older deployment's schema underneath it. The same entry point supports automatic validation and a headed agent session.

We accept additional authentication and provisioning maintenance rather than pretending local tests exercise deployment behavior. The controller and cleanup registry are operational dependencies. Full browser reports are not proof of external login-provider health, and role isolation is not a sandbox for arbitrary malicious PR code.

## Verification and Activation Gates

- Production and disabled-preview routes fail before database initialization; invalid, replayed, wrong-deployment, and expired grants fail.
- Concurrent nonce consumption and bootstrap retries cannot duplicate ownership or sessions.
- Session refresh cannot cross the absolute deadline; revocation, missing registry state, logout, and partial teardown deny access.
- Actual DSQL runtime credentials deny production, non-test schemas, administrative access, and DDL; local PostgreSQL tests alone cannot satisfy this gate. Sibling-preview routing and run ownership are checked separately as logical isolation.
- Interrupted/resumed migrations and asynchronous indexes cannot expose a falsely ready preview.
- Concurrent PRs, revisions, and runs remain isolated; exact-ID cleanup preserves unrelated data and retries partial failures.
- Redirects cannot leak the protection-bypass secret; artifact scanning finds no grant/session material.
- Unit, integration, lint, types, build, existing local E2E, and deployed user-flow checks have separately recorded outcomes; known failures are not described as a green full suite.

Roll out manually on one opted-in PR, then enable automatic reporting without changing branch protection. Disable the feature and revoke runs to roll back. Do not enable deployed automation until credential/trust and cleanup gates pass. Revisit this decision if identity isolation is infeasible on current infrastructure, provisioning cost becomes disproportionate, or testing real authentication providers becomes a primary outcome.
