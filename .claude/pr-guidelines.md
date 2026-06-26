# PR Guidelines — Compass

## Quick-Reference Commands

| Task | Command |
|---|---|
| Type-check | `pnpm tsc --noEmit` |
| Unit tests | `pnpm test` |
| E2E tests | `pnpm test:e2e` |
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

### 4. Docs Screenshots (`pnpm test:e2e`)

```bash
# In one terminal:
pnpm dev

# In another:
pnpm test:e2e
```

**Important:** `pnpm test:e2e` is a screenshot-capture suite (`e2e/screenshots.spec.ts`), **not** a functional test suite. It visits pages and saves PNGs to `public/screenshots/docs/` — there are no assertions and it cannot catch regressions. Its only job is keeping docs screenshots current.

Run it (or manually update the affected screenshot) whenever a UI page visibly changes. The saved PNGs are committed to the repo.

For functional verification of page-level behaviour, run the app and test manually — see Visual Verification below.

## Visual Verification

Any PR that touches UI components must be checked at both breakpoints:

- **Desktop** (1440×900): preferred verification viewport. 1280px is the minimum supported width.
- **Mobile** (390×844 iPhone 14): bottom nav visible, sidebar hidden, kanban columns scroll horizontally.

**Mobile viewport note:** `window.resizeTo()` is a no-op in headless Chromium. Use Playwright device emulation (`devices["iPhone 14"]`) for accurate mobile rendering, running the script from inside the repo directory so it can resolve `@playwright/test`.

Screenshot both breakpoints for UI-only changes and commit them alongside the code.

## Worktree Testing

When verifying a feature branch in a git worktree:

1. **Copy `.env.local`** from the main repo — it is gitignored and absent from worktrees. Auth will fail with `MissingSecret` without it.
2. **Use a different port** — if `pnpm dev` is already running on port 3000 (main branch), start the worktree server with `PORT=3001 pnpm dev`. Confirm which server serves which branch before testing: `lsof -i :3000` then check the process `cwd`.
3. **Run Playwright scripts from inside the worktree** — Node resolves packages from the script's location; running from `/tmp` will fail to find `@playwright/test`.

## Test Data

The `test-org/product` dev workspace is empty by default. Visual verification of flows that require data (solution cards, roadmap items, etc.) needs test data created first. The portal roadmap requires explicitly enabling it in Settings → Portal → Public roadmap before the `/portal/...` route will render.

## Deployment

Vercel creates a preview deployment automatically for each PR branch. Before requesting review:

1. Wait for the preview URL to appear in the PR.
2. Smoke-test the primary user flows in the preview (login, workspace nav, at least one data view).
3. Note the preview URL in the PR description.

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
