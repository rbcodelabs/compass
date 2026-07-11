import { NextRequest, NextResponse } from "next/server";
import { Pool } from "pg";
import { DsqlSigner } from "@aws-sdk/dsql-signer";
import { awsCredentialsProvider } from "@vercel/functions/oidc";
import { readFileSync } from "fs";
import path from "path";
import { getActiveSchema } from "@/lib/schema";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MIGRATIONS = [
  {
    name: "001_init",
    filePath: path.join(process.cwd(), "prisma/migrations/001_init/migration.sql"),
  },
  {
    name: "002_custom_fields",
    filePath: path.join(process.cwd(), "prisma/migrations/002_custom_fields/migration.sql"),
  },
  {
    name: "003_fix_custom_field_tables",
    filePath: path.join(process.cwd(), "prisma/migrations/003_fix_custom_field_tables/migration.sql"),
  },
  {
    name: "004_squads",
    filePath: path.join(process.cwd(), "prisma/migrations/004_squads/migration.sql"),
  },
  {
    name: "005_cross_links",
    filePath: path.join(process.cwd(), "prisma/migrations/005_cross_links/migration.sql"),
  },
  {
    name: "006_api_keys",
    filePath: path.join(process.cwd(), "prisma/migrations/006_api_keys/migration.sql"),
  },
  {
    name: "007_sort_order",
    filePath: path.join(process.cwd(), "prisma/migrations/007_sort_order/migration.sql"),
  },
  {
    name: "008_roadmap_experiment_link",
    filePath: path.join(process.cwd(), "prisma/migrations/008_roadmap_experiment_link/migration.sql"),
  },
  {
    name: "009_feedback_voting",
    filePath: path.join(process.cwd(), "prisma/migrations/009_feedback_voting/migration.sql"),
  },
  {
    name: "010_feedback_indexes",
    filePath: path.join(process.cwd(), "prisma/migrations/010_feedback_indexes/migration.sql"),
  },
  {
    name: "011_docs",
    filePath: path.join(process.cwd(), "prisma/migrations/011_docs/migration.sql"),
  },
  {
    name: "012_doc_metadata",
    filePath: path.join(process.cwd(), "prisma/migrations/012_doc_metadata/migration.sql"),
  },
  {
    name: "013_portal_auth",
    filePath: path.join(process.cwd(), "prisma/migrations/013_portal_auth/migration.sql"),
  },
];

async function getPool(): Promise<Pool> {
  const host = process.env.PGHOST!;
  const signer = new DsqlSigner({
    credentials: awsCredentialsProvider({
      roleArn: process.env.AWS_ROLE_ARN!,
      clientConfig: { region: process.env.AWS_REGION },
    }),
    hostname: host,
    region: process.env.AWS_REGION ?? "us-east-1",
    expiresIn: 900,
  });

  return new Pool({
    host,
    user: process.env.PGUSER ?? "admin",
    database: process.env.PGDATABASE ?? "postgres",
    password: () => signer.getDbConnectAdminAuthToken(),
    port: 5432,
    ssl: true,
    max: 3,
  });
}

function checkAuth(req: NextRequest): boolean {
  const secret = process.env.MIGRATION_SECRET;
  if (!secret) return false;
  return req.headers.get("x-migration-secret") === secret;
}

// GET — check migration status
export async function GET(req: NextRequest) {
  if (!checkAuth(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const schema = getActiveSchema();
  const pool = await getPool();
  const client = await pool.connect();

  try {
    // Check if tracking table exists
    const { rows } = await client.query<{ name: string }>(`
      SELECT migration_name as name
      FROM "${schema}"._prisma_migrations
      ORDER BY finished_at ASC
    `).catch(() => ({ rows: [] as { name: string }[] }));

    return NextResponse.json({
      schema,
      appliedMigrations: rows.map((r) => r.name),
      manifest: MIGRATIONS.map((m) => m.name),
    });
  } finally {
    client.release();
    await pool.end();
  }
}

// POST — apply a migration (or all pending)
export async function POST(req: NextRequest) {
  if (!checkAuth(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const targetScript: string | undefined = body.script;

  const schema = getActiveSchema();
  const pool = await getPool();
  const client = await pool.connect();
  const log: string[] = [`Using schema: ${schema}`];

  try {
    // Ensure schema exists
    await client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);

    // Ensure migration tracking table
    await client.query(`
      CREATE TABLE IF NOT EXISTS "${schema}"._prisma_migrations (
        id               UUID    NOT NULL DEFAULT gen_random_uuid(),
        migration_name   VARCHAR(255) NOT NULL,
        started_at       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        finished_at      TIMESTAMP(3),
        CONSTRAINT _prisma_migrations_pkey PRIMARY KEY (id)
      )
    `);

    // Get already-applied migrations
    const { rows: applied } = await client.query<{ migration_name: string }>(
      `SELECT migration_name FROM "${schema}"._prisma_migrations WHERE finished_at IS NOT NULL`
    );
    const appliedSet = new Set(applied.map((r) => r.migration_name));

    const toRun = MIGRATIONS.filter((m) =>
      targetScript ? m.name === targetScript : !appliedSet.has(m.name)
    );

    if (toRun.length === 0) {
      return NextResponse.json({ message: "Nothing to apply. All migrations up to date.", schema });
    }

    for (const migration of toRun) {
      log.push(`\nApplying: ${migration.name}`);

      // Record start
      await client.query(
        `INSERT INTO "${schema}"._prisma_migrations (migration_name) VALUES ($1)`,
        [migration.name]
      );

      const rawSql = readFileSync(migration.filePath, "utf-8");

      // Strip all SQL line comments (-- ...) before splitting, so a leading
      // comment on a CREATE statement can't cause the whole statement to be
      // silently dropped by the startsWith("--") filter.
      const strippedSql = rawSql
        .split("\n")
        .map((line) => line.replace(/--.*$/, "").trimEnd())
        .join("\n");

      // Split on statement boundaries and run them one by one.
      const statements = strippedSql
        .split(/;\s*\n/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .map((s) => (s.endsWith(";") ? s : `${s};`));

      // Prefix unqualified DDL with schema search_path
      await client.query(`SET search_path TO "${schema}"`);

      for (const stmt of statements) {
        try {
          await client.query(stmt);
          const label = stmt.slice(0, 60).replace(/\s+/g, " ");
          log.push(`  ✓ ${label}…`);
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          if (msg.includes("already exists")) {
            log.push(`  ~ already exists (skipped)`);
          } else {
            log.push(`  ✗ Error: ${msg}`);
            throw e;
          }
        }
      }

      // Mark finished
      await client.query(
        `UPDATE "${schema}"._prisma_migrations SET finished_at = CURRENT_TIMESTAMP WHERE migration_name = $1`,
        [migration.name]
      );

      log.push(`  ✅ ${migration.name} applied`);
    }

    return NextResponse.json({ message: log.join("\n"), schema });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg, log: log.join("\n"), schema }, { status: 500 });
  } finally {
    client.release();
    await pool.end();
  }
}
