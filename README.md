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

Full product documentation lives in [`docs/content/`](docs/content/), starting
with [the overview](docs/content/00-overview.md).

## Stack

Next.js 16 · React 19 · TypeScript · Prisma 7 · PostgreSQL · Auth.js ·
Tailwind 4 · Vitest · Playwright

In production Compass runs on Vercel against **Aurora DSQL**, authenticated with
Vercel OIDC rather than a static connection string. Locally it runs against plain
PostgreSQL. `lib/db.ts` picks the path: set `DATABASE_URL` and it uses local
Postgres; set `PGHOST` and it signs DSQL tokens.

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
