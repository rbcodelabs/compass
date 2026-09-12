# Contributing to Compass

Thanks for your interest in Compass. This guide covers local setup, the checks a
change has to pass, and how pull requests are handled.

By contributing you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE), the same license that covers the project.

## Prerequisites

- **Node 22** (`.node-version`, and `engines.node` in `package.json`)
- **pnpm 10** (`engines.pnpm`; the repo pins `pnpm@10.34.5` via `packageManager`)
- **PostgreSQL** running locally — only needed for the app itself and the
  functional end-to-end tests. Unit tests need no database.

## Setup

```bash
pnpm install
```

### Database

Compass isolates environments by **PostgreSQL schema inside one database**, not
by separate databases. `lib/schema.ts` resolves the active schema from the
environment: `NODE_ENV=development` → `compass_dev`, preview → `compass_preview`,
production → `compass_prod`.

Point `DATABASE_URL` at your local Postgres in `.env.local`:

```bash
DATABASE_URL=postgresql://USER:PASSWORD@localhost:5437/compass?sslmode=disable
```

`lib/db.ts` branches on this: when `DATABASE_URL` is set it connects with plain
`pg` and no AWS involvement. When it is absent it requires `PGHOST` and signs
Aurora DSQL tokens — that is the deployed path, not the local one.

Create the tables:

```bash
pnpm exec prisma db push
```

> `prisma db push` is the mechanism this project uses to materialise a schema —
> `scripts/prepare-e2e-database.mjs` does exactly this for the end-to-end
> database. There is no migration-runner command for local development;
> `prisma/migrations/` is applied through the authenticated admin endpoint in
> deployed environments only.

### Enable the secret-scanning hook

Compass is a public repository. A credential committed to it — on any branch, in
any commit, however briefly — must be treated as burned. Please enable the local
hook:

```bash
brew install gitleaks   # or see https://github.com/gitleaks/gitleaks
pnpm hooks:install
```

This scans staged changes before each commit. It is opt-in, adds no npm
dependency, and prints a warning rather than blocking if gitleaks is not
installed. CI scans full history on every pull request regardless.

Full details, including how to handle a false positive:
[docs/maintenance/secret-scanning.md](docs/maintenance/secret-scanning.md).

### Run it

```bash
pnpm dev
```

Open http://localhost:3000/login and click **⚡ Dev Login**. Development builds
register only a credentials provider (`auth.ts`), signing you in as
`dev@localhost.dev` — no email service required.

## Checks

Run these before opening a pull request. The first four are what CI enforces in
`.github/workflows/ui-system.yml`:

```bash
pnpm lint          # eslint
pnpm test          # vitest — no database required
pnpm ui:colors     # design-token gate
pnpm ui:primitives # shared-primitive gate
pnpm typecheck     # tsc --noEmit
```

### Test tiers

| Command | Scope | Needs |
| --- | --- | --- |
| `pnpm test` | Unit tests (`__tests__/`) | Nothing — CI runs these with no database |
| `pnpm test:e2e:functional` | Functional E2E | Local Postgres + `DATABASE_URL`; Playwright starts the dev server itself |
| `pnpm test:e2e` | Screenshot suite | Runs against a deployed URL, not local |

The functional suite prepares an **isolated** `compass_e2e` database first;
`scripts/prepare-e2e-database.mjs` refuses to run against any target other than a
local database literally named `compass_e2e`, so it cannot touch your dev data.

Install browsers once with `pnpm exec playwright install chromium`.

## Pull requests

1. **Branch** off `main`. Do not commit directly to `main`.
2. **Fill in the PR template** (`.github/pull_request_template.md`) — it includes
   a UI-system checklist and asks you to list the verification you performed.
   State what you actually observed, not what you expect to work.
3. **CI must pass.** Pull requests run the UI-system checks, the secret scan, and
   the authenticated preview suites.
4. **Squash merge** is the convention; commit subjects on `main` read
   `type(scope): summary (#123)`.

### Conventions worth knowing

- **Reuse before you build.** The UI-system checklist exists because the fastest
  way to get a change rejected is to hand-roll a component that already exists as
  a shared primitive. `pnpm ui:primitives` and `pnpm ui:colors` enforce parts of
  this automatically.
- **No foreign-key constraints.** `relationMode = "prisma"` means the database
  will not stop you writing an orphaned row. Cascades and referential integrity
  are your responsibility in application code.
- **Never commit a real secret**, including in tests or docs. Use an obvious
  placeholder. If you do commit one, say so immediately — rotation matters far
  more than the embarrassment, and amending the commit does not remove the value
  from history once pushed.

## Reporting security issues

Please report suspected vulnerabilities or leaked credentials **privately** to
the maintainers rather than opening a public issue.
