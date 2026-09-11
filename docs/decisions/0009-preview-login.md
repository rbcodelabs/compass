# ADR-0009: Preview Login for Human Exploration

**Date:** 2026-09-11
**Status:** Accepted

## Context

ADR-0008 built a real system for authenticated preview validation — but it targets CI and automated agent runs, and only activates once per-PR Aurora DSQL schema/IAM provisioning and a controller signing keypair exist. None of that provisioning has happened yet. In the meantime, a human reviewing a preview deployment in an ordinary browser has no way in: the earlier `/preview-login` page (removed in PR #195) minted Auth.js sessions directly, with no enable flag, no access code, a 30-day session, a hand-rolled cookie, and no binding to any registry — a real conflict with ADR-0008's contract on every count.

This decision adds a second, smaller `/preview-login` surface for exactly the gap ADR-0008 doesn't cover: a person clicking through a deployment, not a test runner.

## Decision

`/preview-login` and `POST /api/preview-login/start` are gated by `PREVIEW_LOGIN_ENABLED=1` (checked alongside `VERCEL_ENV=preview`) and a required `PREVIEW_LOGIN_ACCESS_CODE`. Disabled or missing either, the page 404s and the route 404s, before any database access — no codeless bypass. Both are off by default on every deployment; enabling them is a per-branch opt-in via Vercel env vars, not a repo-wide default.

On a valid code, the visitor picks a persona (Workspace Admin or Team Member) and lands in a fixed, idempotently-seeded sample org/workspace (`preview-sample` / `workspace`) on the **existing shared** `compass_preview` schema — the same connection every preview deployment already uses today. The seed reuses `applyPreviewScenario(..., "full-data")` from `lib/preview-automation/scenarios.ts`, so the fixture never drifts from the automation system's own demo data. The session is an ordinary Auth.js database session (`Session` row, `previewlogin_`-prefixed token, 60-minute hard expiry), set via the shared `PREVIEW_SESSION_COOKIE`/`PREVIEW_SESSION_OPTIONS` cookie contract — but it carries none of ADR-0008's signed-grant, run-registry, or revocation machinery.

### Distinct from ADR-0008

| | ADR-0008 preview automation | ADR-0009 preview login |
|---|---|---|
| Purpose | CI / automated product-flow validation | Human clicking around a deployment |
| Trust boundary | Per-PR isolated schema + scoped IAM runtime role + signed grants | Shared `compass_preview` schema, existing preview DB credentials |
| Session binding | Run registry; revocable; adapter enforces the run's own deadline | Plain `Session` row; adapter's ordinary expiry check, nothing preview-aware |
| Activation | `PREVIEW_AUTOMATION_ENABLED` + provisioned DSQL roles + signing keypair | `PREVIEW_LOGIN_ENABLED` + `PREVIEW_LOGIN_ACCESS_CODE`, no new infrastructure |

The `previewlogin_` token prefix is deliberately distinct from automation's `preview_` prefix: `createLazyPrismaAuthAdapter` only special-cases `preview_`-prefixed tokens, and only enforces a run deadline when automation is enabled. A `previewlogin_` token instead falls through to the adapter's normal, unmodified `@auth/prisma-adapter` session handling — no changes to `auth.ts` or the adapter were needed or made.

## Consequences

This session type has no revocation path beyond its 60-minute expiry and no per-visitor isolation — every preview-login visitor to a given branch shares the same sample workspace, since it reuses the same shared schema every preview deployment already writes to today. That's an acceptable v1 tradeoff for a low-stakes, off-by-default, code-gated exploration surface; it would not be acceptable for anything resembling untrusted or adversarial access.

If/when ADR-0008's DSQL/IAM rollout gates are met and per-PR isolated schemas become the norm, this feature could be revisited to ride on that system instead — for example, issuing preview-login sessions against a run-scoped workspace rather than the shared one. Until then, the two systems stay independent: this ADR does not modify, gate behind, or depend on any ADR-0008 code path.
