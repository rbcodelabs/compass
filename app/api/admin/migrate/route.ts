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
  {
    name: "014_feedback_type",
    filePath: path.join(process.cwd(), "prisma/migrations/014_feedback_type/migration.sql"),
  },
  {
    name: "015_roadmap_dates",
    filePath: path.join(process.cwd(), "prisma/migrations/015_roadmap_dates/migration.sql"),
  },
  {
    name: "016_audit_fields_source_tracking",
    filePath: path.join(process.cwd(), "prisma/migrations/016_audit_fields_source_tracking/migration.sql"),
  },
  {
    name: "017_evidence_graph",
    filePath: path.join(process.cwd(), "prisma/migrations/017_evidence_graph/migration.sql"),
  },
  {
    name: "018_workspace_branding",
    filePath: path.join(process.cwd(), "prisma/migrations/018_workspace_branding/migration.sql"),
  },
  {
    name: "019_scoring_models",
    filePath: path.join(process.cwd(), "prisma/migrations/019_scoring_models/migration.sql"),
  },
  {
    name: "020_portal_sso",
    filePath: path.join(process.cwd(), "prisma/migrations/020_portal_sso/migration.sql"),
  },
  {
    name: "021_feedback_attachments",
    filePath: path.join(process.cwd(), "prisma/migrations/021_feedback_attachments/migration.sql"),
  },
  {
    name: "022_solution_comments",
    filePath: path.join(process.cwd(), "prisma/migrations/022_solution_comments/migration.sql"),
  },
  {
    name: "023_solution_comment_plan_status",
    filePath: path.join(process.cwd(), "prisma/migrations/023_solution_comment_plan_status/migration.sql"),
  },
  {
    name: "024_canvas_node_positions",
    filePath: path.join(process.cwd(), "prisma/migrations/024_canvas_node_positions/migration.sql"),
  },
  {
    // Numbered "024" on main too — both branches independently picked the
    // next sequential number off of 023 before either merged. Different
    // migration names (tracked by full string, not numeric prefix), so no
    // functional collision — just cosmetic. Not renumbering
    // 024_canvas_node_positions since it's already applied against this
    // PR's preview deployment; renaming it would make the migrate endpoint
    // treat already-applied DDL as new.
    name: "024_launch_tiers_checklists",
    filePath: path.join(process.cwd(), "prisma/migrations/024_launch_tiers_checklists/migration.sql"),
  },
  {
    name: "025_doc_gtm_positioning_brief",
    filePath: path.join(process.cwd(), "prisma/migrations/025_doc_gtm_positioning_brief/migration.sql"),
  },
  {
    name: "026_roadmap_private_items",
    filePath: path.join(process.cwd(), "prisma/migrations/026_roadmap_private_items/migration.sql"),
  },
  {
    name: "027_tasks",
    filePath: path.join(process.cwd(), "prisma/migrations/027_tasks/migration.sql"),
  },
  {
    name: "028_agent_runtime_config",
    filePath: path.join(process.cwd(), "prisma/migrations/028_agent_runtime_config/migration.sql"),
  },
  {
    name: "029_agent_conversations",
    filePath: path.join(process.cwd(), "prisma/migrations/029_agent_conversations/migration.sql"),
  },
  {
    name: "030_agent_audit_log",
    filePath: path.join(process.cwd(), "prisma/migrations/030_agent_audit_log/migration.sql"),
  },
  {
    name: "031_doc_versions",
    filePath: path.join(process.cwd(), "prisma/migrations/031_doc_versions/migration.sql"),
  },
  {
    name: "032_doc_comments",
    filePath: path.join(process.cwd(), "prisma/migrations/032_doc_comments/migration.sql"),
  },
  {
    name: "033_feedback_grid_indexes",
    filePath: path.join(process.cwd(), "prisma/migrations/033_feedback_grid_indexes/migration.sql"),
  },
  {
    name: "034_artifacts",
    filePath: path.join(process.cwd(), "prisma/migrations/034_artifacts/migration.sql"),
  },
  {
    // Numbered "034" on this branch too -- same independently-picked-next-number
    // collision as 024 above. Different migration names (tracked by full
    // string, not numeric prefix), so no functional collision -- just
    // cosmetic. Not renumbering to keep parity with the migration folder
    // name already shipped in prisma/migrations/034_research_capture.
    name: "034_research_capture",
    filePath: path.join(process.cwd(), "prisma/migrations/034_research_capture/migration.sql"),
  },
  {
    name: "035_research_agent_scope",
    filePath: path.join(process.cwd(), "prisma/migrations/035_research_agent_scope/migration.sql"),
  },
];

async function getPool(): Promise<Pool> {
  // worktree-bootstrap provides a local Postgres URL. Keep local verification
  // on the exact same migration runner/search_path as DSQL deployments.
  if (process.env.DATABASE_URL) {
    return new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
  }
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
          // ASYNC is mandatory on DSQL and unsupported by local PostgreSQL.
          // DATABASE_URL is the worktree-bootstrap local-mode signal.
          const executableStmt = process.env.DATABASE_URL
            ? stmt.replace(/\bINDEX ASYNC\b/gi, "INDEX")
            : stmt;
          await client.query(executableStmt);
          const label = executableStmt.slice(0, 60).replace(/\s+/g, " ");
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
