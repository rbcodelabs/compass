# Compass Testing Guide

## Philosophy

Test what matters. Compass uses three layers:

- **Unit tests** — pure functions in `lib/` with no dependencies
- **Integration tests** — server action validation logic with mocked Prisma
- **E2E tests** — critical user journeys in a real browser against a running server

Avoid snapshot tests (brittle, high churn) and avoid testing Prisma's generated types or third-party internals.

---

## Testing Pyramid

### Unit Tests (`__tests__/lib/`)

Pure logic, zero dependencies. Run in milliseconds.

Target: `lib/schema.ts`, `lib/utils.ts`, any pure utility added to `lib/`.

Coverage expectation: **100%** on `lib/schema.ts`.

### Integration Tests (`__tests__/actions/`)

Server action Zod validation paths — mock the DB, test the parse + error behavior.

The goal is confidence that each action rejects bad input and accepts good input. DB behavior is the DB's job (and E2E's job).

Coverage expectation: **100%** on Zod validation branches of each tested action.

### E2E Tests (`e2e/`)

Full browser flows against a running dev server (or `BASE_URL` override for preview/CI). These test the real auth, real DB (dev schema), and real UI.

Critical flows to maintain:
- Auth (login via Dev Login, session persistence)
- OKR create (cycle → objective → key result → check-in)
- Opportunity board (create, update status)
- Experiment lifecycle (draft → running → complete)
- Public feedback portal

---

## Test File Naming

| Layer | Location | Example |
|---|---|---|
| Unit | `__tests__/lib/` | `__tests__/lib/schema.test.ts` |
| Integration | `__tests__/actions/` | `__tests__/actions/okrs.test.ts` |
| E2E | `e2e/` | `e2e/okrs.spec.ts` |

---

## Running Tests

```bash
# Unit + integration (one-shot)
pnpm test

# Watch mode — use during TDD
pnpm test:watch

# Coverage report (outputs to coverage/)
pnpm test:coverage

# E2E — requires dev server running on localhost:3000
pnpm test:e2e

# E2E against a specific URL (preview, staging, etc.)
BASE_URL=https://my-preview.vercel.app pnpm test:e2e

# Run only the auth setup project
pnpm test:e2e -- --project=auth-setup

# Update screenshots
pnpm test:e2e -- --project=screenshots --update-snapshots
```

---

## Auth in E2E Tests

Playwright uses the `storageState` pattern to share a logged-in browser session across tests.

**How it works:**

1. `e2e/auth.setup.ts` navigates to `/login` and clicks the Dev Login button.
2. The resulting session is saved to `e2e/.auth/user.json`.
3. All tests in the `chromium` and `mobile` projects load that session before running — no re-login per test.

The `e2e/.auth/` directory is gitignored. The `auth-setup` project runs before any test that depends on it (see `playwright.config.ts` `dependencies` field).

**If auth breaks in CI:** confirm the dev server is accessible at `BASE_URL` and that `NODE_ENV=development` is set (Dev Login is only rendered in dev mode).

---

## DB Strategy

| Layer | Strategy |
|---|---|
| Unit tests | No DB. Pure function input/output. |
| Integration tests | `vi.mock('@/lib/db')` — Prisma never instantiated. |
| E2E tests | Real DB. Local dev server uses `DATABASE_URL` → `compass_dev` schema. |

Never seed data in unit or integration tests. If an E2E test needs specific data, either create it through the UI or document the assumption in the test comment.

---

## What NOT to Test

- Prisma-generated types or client behavior
- UI snapshot tests
- Third-party library internals (Auth.js, Zod, Prisma)
- CSS/styling

---

## Coverage Targets

| File / scope | Target |
|---|---|
| `lib/schema.ts` | 100% |
| Server action Zod validation paths | 100% per action tested |
| Auth flow | E2E |
| OKR create flow | E2E |
| Opportunity create | E2E |
| Experiment lifecycle | E2E |

Run `pnpm test:coverage` to see the current report. Coverage HTML is at `coverage/index.html`.

---

## CI Expectations

- Unit + integration tests **must pass** before a PR can merge.
- E2E tests run in CI against the preview URL via `BASE_URL` env var.
- The `VERCEL_BYPASS_TOKEN` env var is used to bypass Vercel deployment protection on preview URLs (set in CI secrets).

---

## Adding New Tests

### New server action

1. Add a Zod schema (already the pattern in all existing actions).
2. Add a `describe` block in `__tests__/actions/<module>.test.ts`.
3. Test: empty/missing required fields throw, valid data resolves.
4. Add an E2E spec if the action is on a critical path.

### New lib utility

1. Add `__tests__/lib/<utility>.test.ts`.
2. Aim for 100% branch coverage.

### New E2E flow

1. Add `e2e/<feature>.spec.ts`.
2. The test file gets the pre-authenticated session automatically (via `storageState` in `playwright.config.ts`).
3. If the test needs a fresh unauthenticated context, use `test.use({ storageState: { cookies: [], origins: [] } })`.
