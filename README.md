# Compass

**A product discovery and delivery platform built around Teresa Torres' Opportunity Solution Tree.**

Compass gives product teams a structured path from business outcome to shipped
experiment, with every decision traceable back to customer evidence. Instead of
a backlog of disconnected features, work is organised as a tree: outcomes at the
top, customer opportunities beneath them, competing solutions under each
opportunity, and the assumptions those solutions depend on.

Hosted at **[compass.rbcodelabs.com](https://compass.rbcodelabs.com)**.

## The model

Five connected layers:

| Layer | What it holds |
| --- | --- |
| **Outcomes** | OKRs — the measurable result a workspace is trying to achieve |
| **Opportunities** | Customer problems and needs found through research |
| **Solutions** | Competing ideas for addressing an opportunity |
| **Experiments** | Tests that validate or kill a solution's riskiest assumptions |
| **Roadmap** | Now / Next / Later, each item tracing back to the evidence that justifies it |

Opportunities, solutions, and assumptions carry linked **Evidence** — interview
quotes, support tickets, experiment results — so a claim on the tree is never
just an opinion.

Alongside the core tree: customer-interview **Capture**, a public **Feedback
Portal** with voting, hierarchical **Docs**, **Squads**, **Custom Fields**,
per-workspace **Branding**, and an **MCP API** that lets AI agents read and write
discovery data programmatically.

The **[REST API](docs/content/09-rest-api.md)** runs in the same Compass app
deployment at `/api/v1`, with a public
[OpenAPI 3.1 document](https://compass.rbcodelabs.com/api/v1/openapi.json).
Authenticate with a Compass API key (including service keys) or an OAuth bearer
token for the `/api/v1` resource with `api:read` or `api:write` scope. The guide
documents authorization boundaries, including excluded human decision recording,
solution-plan approval, decision application, and release dispatch operations.

The custom [API explorer](https://compass.rbcodelabs.com/help/api-explorer)
browses that live contract and can explicitly execute authenticated GET reads on
the current deployment. Writes are documentation-only; credentials and results
remain in page memory. See the [explorer guide](docs/content/09-api-explorer.md).

The opt-in **[Updates](docs/content/22-updates.md)** landing page groups recent
workspace activity into inspectable stories, with personal catch-up state and
explicit Mark caught up / Undo controls. It requires the registered
`060_workspace_updates` migration and `WORKSPACE_UPDATES_ENABLED=1`; capture is
prospective, with no historical backfill.

Full product documentation lives in [`docs/content/`](docs/content/), starting
with [the overview](docs/content/00-overview.md).

## Stack

Next.js 16 · React 19 · TypeScript · Prisma 7 · PostgreSQL · Auth.js ·
Tailwind 4 · Vitest · Playwright

Compass runs on Vercel. Since 2026-10-09 production uses **Supabase Postgres**
via `DATABASE_URL` (the Aurora DSQL account became unavailable); the DSQL path
(Vercel OIDC, no static connection string) remains in the code. Locally it runs
against plain PostgreSQL. `lib/db.ts` picks the path: set `DATABASE_URL` and it
uses a plain `pg` pool; set `PGHOST` and it signs DSQL tokens.

On the `DATABASE_URL` path the pooler mode is detected from the port:

- **Runtime (`DATABASE_URL`, falling back to the Vercel Supabase integration's
  `POSTGRES_URL`) should be Supabase's transaction pooler (port
  6543).** A backend connection is held only while a transaction runs, so many
  serverless instances no longer exhaust the 15-slot session pool
  (`EMAXCONNSESSION`). Each instance keeps at most 5 connections; the limit that
  matters is the pooler's client-connection limit. This is safe because Prisma's
  `schema` option schema-qualifies table names in each statement (no session
  `search_path`), statements are unnamed (no server-side prepared statements)
  and interactive `$transaction`s pin one connection until commit. Do not add
  session state (`SET`, advisory locks, `LISTEN`, temp tables) to runtime code.
- **Migrations use `DATABASE_MIGRATION_URL`** (session pooler, port 5432),
  then `POSTGRES_URL_NON_POOLING`, then the runtime URL. `/api/admin/migrate`
  and the Prisma CLI use this order; the migrate route refuses to run over a
  transaction-mode URL. The integration's `POSTGRES_URL_NON_POOLING` is the
  direct host (`db.<ref>.supabase.co`), which is IPv6-only and unreachable from
  Vercel, so set `DATABASE_MIGRATION_URL` to the **session pooler** string
  instead.
- Integration URLs (`?sslmode=require&supa=base-pooler.x`) are normalized when
  used as fallbacks: `supa` is dropped, and `uselibpqcompat=true` is added
  because `pg-connection-string` otherwise treats `sslmode=require` as
  `verify-full`, which fails against the Supabase pooler's CA chain. The result
  is an encrypted but unverified connection; use an explicit `DATABASE_URL`
  with `sslrootcert` for full verification. Explicit `DATABASE_URL` values are
  never rewritten.
- Automation previews ignore `POSTGRES_*` and `DATABASE_MIGRATION_URL`, and
  still forbid `DATABASE_URL`.

**Production cutover (Supabase integration):** (1) set `DATABASE_MIGRATION_URL`
to the session-pooler string (port 5432) in production; (2) merge and deploy
this change; (3) delete production `DATABASE_URL` so runtime falls through to
`POSTGRES_URL` (6543); (4) redeploy (env changes need a new deployment);
(5) verify authenticated `GET /api/admin/migrate` and watch for
`EMAXCONNSESSION`. **Rollback:** re-add `DATABASE_URL` with the 5432 string and
redeploy.
- On a session-mode URL (port 5432, or only `DATABASE_URL` set to such a URL)
  each instance keeps at most 3 connections, as before. `DATABASE_POOL_MAX`
  overrides the cap in either mode and `DATABASE_POOLER_MODE=transaction|session`
  overrides port-based detection.

Because DSQL does not support foreign-key constraints, `prisma/schema.prisma`
uses `relationMode = "prisma"` — referential integrity is enforced by Prisma at
the application layer, not by the database.

## Quickstart

Requires **Node 22** and **pnpm 10** (see `engines` in `package.json`).

```bash
pnpm install

# Point at a local Postgres. Environment isolation is by schema, not database:
# NODE_ENV=development resolves to the `compass_dev` schema (lib/schema.ts).
echo 'DATABASE_URL=postgresql://USER:PASSWORD@localhost:5437/compass?sslmode=disable' >> .env.local

# Create the tables in that schema
pnpm exec prisma db push

pnpm dev
```

Then open http://localhost:3000/login and click **⚡ Dev Login** — development
builds register a credentials provider instead of Google or magic-link email, so
no mail service is needed. Production auth (Resend magic link + Google) is never
constructed in dev.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full setup, the test tiers, and
the checks a pull request must pass.

## Security

Compass is scanned for committed secrets on every pull request and every push to
`main`, and GitHub push protection is enabled. If you believe you have found a
security issue or a leaked credential, please report it privately rather than
opening a public issue — see [docs/maintenance/secret-scanning.md](docs/maintenance/secret-scanning.md).

## License

[Apache License 2.0](LICENSE). Copyright 2026 RB Code Labs.
