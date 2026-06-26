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

### 4. E2E Tests

```bash
# In one terminal:
pnpm dev

# In another:
pnpm test:e2e
```

Playwright tests are in `e2e/`. Run them locally if your change touches navigation, auth, or page-level rendering. They require the dev server running on the default port.

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
