# PR Guidelines — Compass

## Quick-Reference Commands

| Task | Command |
|---|---|
| Type-check | `pnpm tsc --noEmit` |
| Unit tests | `pnpm test` |
| E2E screenshots | `pnpm test:e2e` |
| E2E functional | `pnpm test:e2e:functional` |
| Build | `pnpm build` |

## Branch Naming

- `fix/<slug>` for bug fixes
- `feat/<slug>` for new features
- `chore/<slug>` for non-user-facing changes (deps, config, tooling)

## Before Opening a PR

### 1. Unit and Integration Tests

```bash
pnpm test
```

Runs Vitest in non-watch mode. All tests must pass. Tests live alongside source files — do not skip or mark as pending to make the suite pass. New tools and routes must have unit tests in `__tests__/`.

### 2. TypeScript

```bash
pnpm tsc --noEmit
```

Must produce no errors. `any` casts require a comment explaining why.

### 3. Build

```bash
pnpm build
```

Run before opening a PR to catch type errors and build failures that `tsc` alone might miss.

### 4. E2E Tests

There are two separate Playwright suites:

**Screenshots** (CI-safe, no local server required):
```bash
pnpm test:e2e
```
Visits pages on the Vercel preview URL and saves PNGs to `public/screenshots/docs/`. No assertions — its only job is keeping docs screenshots current. Run (or manually update the screenshot) whenever a UI page visibly changes.

**Functional** (requires local Podman Postgres + dev server):
```bash
# Auto-starts dev server on port 3002, seeds e2e-test-org, runs assertions, teardown:
pnpm test:e2e:functional

# Keep DB state for post-failure inspection:
E2E_SKIP_TEARDOWN=1 pnpm test:e2e:functional
```
Covers OKRs, Discovery→Roadmap, Experiments, and Portal flows with real DB mutations. Run when a PR touches any of these journeys. Requires `.env.local` in the worktree and local Podman Postgres running.

**Suites live in:**
- `e2e/screenshots.spec.ts` — docs screenshots
- `e2e/functional/specs/` — functional journeys (OKRs, Discovery, Experiments, Portal)
- `e2e/functional/global-setup.ts` / `global-teardown.ts` — DB seed + cleanup

## Visual Verification

Any PR that touches UI components must be checked at both breakpoints:

- **Desktop** (`md+` breakpoint, 768px+ / 1280×800): sidebar visible, workspace dropdown, nav links, user area.
- **Mobile** (below `md` / 390×844 iPhone 14): bottom nav and mobile header visible, sidebar hidden.

Use browser DevTools device emulation or resize to verify. Screenshot both breakpoints for UI-only changes.

## Deployment

Vercel creates a preview deployment automatically for each PR branch. Before requesting review:

1. Wait for the preview URL to appear in the PR.
2. Smoke-test the primary user flows in the preview (login, workspace nav, at least one data view).
3. Note the preview URL in the PR description.

### Production deployment (after merge to main)

**Claude handles this — the user does not run these steps manually.**

After a PR merges to main and Vercel deploys to production:

1. **Wait for the production deploy** — poll `gh run list --branch main --limit 3` or check the Vercel dashboard. Production URL: `https://compass.rbcodelabs.com`.

2. **Run any one-time data migrations** listed in the PR description. Example:
   ```bash
   node --experimental-strip-types scripts/<migration-name>.ts
   ```
   Check the PR body for a "Migration required" section. If none is listed, skip this step.

3. **Smoke-test production** using `agent-browser`:
   - Log in at `https://compass.rbcodelabs.com/login`
   - Exercise the primary flows touched by the PR (e.g. if docs changed, open a doc and verify formatting)
   - Verify no 500s or console errors on the affected pages
   - Take a screenshot as evidence

4. **Report back** with: deploy URL, migration result (if applicable), and smoke-test outcome. If anything is broken, open a fix PR immediately.

## Database Migrations

If `prisma/schema.prisma` changed, run against the dev DSQL cluster:

```bash
prisma db push
```

- Do **not** use `prisma migrate dev` or `prisma migrate deploy` — Aurora DSQL uses `db push`.
- Never use `@default(autoincrement())` or `CREATE TYPE` in schema changes.
- Confirm the push succeeded before opening the PR.

## MCP Tools

Every new MCP tool must have unit tests in `__tests__/`. Handlers should be extracted into `lib/` for testability (e.g., `lib/feedback-tool-handlers.ts`).

## Code Patterns

- **Data fetching**: use async server components. Call `getPrisma()` from `lib/db.ts` — never import `PrismaClient` directly.
- **Client components**: add `"use client"` only when the component needs browser APIs, event handlers, or React hooks. Data fetching belongs in the server layer.
- **Scripts**: TypeScript/Node.js only. Node v22.6+ runs `.ts` files natively with a `#!/usr/bin/env node` shebang — no compilation step. No Python scripts.
- **Styling**: Tailwind utility classes. Dark sidebar uses `slate-950`/`slate-900` backgrounds; light main content uses `slate-50`. Follow existing patterns in `components/`.

## Tracking

No Linear integration — track work in Compass itself.
