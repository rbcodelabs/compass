import { NextRequest, NextResponse } from "next/server";
import { Pool, PoolClient } from "pg";
import { DsqlSigner } from "@aws-sdk/dsql-signer";
import { awsCredentialsProvider } from "@vercel/functions/oidc";
import { readFileSync } from "fs";
import path from "path";
import { getActiveSchema } from "@/lib/schema";
import { planDsqlWriteBatch } from "@/lib/dsql-backfill";

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
  {
    name: "036_research_capture_hardening",
    filePath: path.join(process.cwd(), "prisma/migrations/036_research_capture_hardening/migration.sql"),
  },
  {
    name: "037_research_guided_ux",
    filePath: path.join(process.cwd(), "prisma/migrations/037_research_guided_ux/migration.sql"),
  },
  {
    name: "038_research_blob_cleanup",
    filePath: path.join(process.cwd(), "prisma/migrations/038_research_blob_cleanup/migration.sql"),
  },
  {
    name: "039_native_decision_gates",
    filePath: path.join(process.cwd(), "prisma/migrations/039_native_decision_gates/migration.sql"),
  },
  {
    name: "040_release_authorization",
    filePath: path.join(process.cwd(), "prisma/migrations/040_release_authorization/migration.sql"),
  },
  {
    name: "041_portfolio_capacity_ledger",
    filePath: path.join(process.cwd(), "prisma/migrations/041_portfolio_capacity_ledger/migration.sql"),
  },
];

const DSQL_WRITE_LIMITS = {
  maxRows: 3_000,
  maxBytes: 10 * 1024 * 1024,
} as const;

async function backfillRoadmapCommitmentProvenance(client: PoolClient, schema: string, log: string[]) {
  let totalUpdated = 0;
  for (;;) {
    const { rows } = await client.query<{ id: string; estimated_bytes: string }>(`
      SELECT id, pg_column_size(ri)::bigint AS estimated_bytes
      FROM "${schema}".roadmap_items ri
      WHERE now_commitment_provenance IS NULL
      ORDER BY id
      LIMIT ${DSQL_WRITE_LIMITS.maxRows}
    `);
    if (rows.length === 0) break;
    const batch = planDsqlWriteBatch(
      rows.map((row) => ({ id: row.id, estimatedBytes: toSafeNumber(row.estimated_bytes) })),
      DSQL_WRITE_LIMITS,
    );
    if (batch.length === 0) throw new Error("Migration 039 could not plan a safe provenance backfill batch.");
    await client.query("BEGIN");
    try {
      const result = await client.query(
        `UPDATE "${schema}".roadmap_items
         SET now_commitment_provenance = 'LEGACY_UNGATED'
         WHERE id = ANY($1::uuid[])
           AND now_commitment_provenance IS NULL`,
        [batch.map((row) => row.id)],
      );
      await client.query("COMMIT");
      totalUpdated += result.rowCount ?? 0;
      log.push(`  ✓ provenance backfill batch: ${result.rowCount ?? 0} rows`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
  return totalUpdated;
}

const RESEARCH_CAPTURE_INDEXES = [
  "idx_research_participant_tokens_hash",
  "idx_research_participant_tokens_study_kind",
  "idx_research_sessions_resume_token",
  "idx_research_sessions_participant_token",
  "idx_research_requests_session_key",
  "idx_research_requests_session_created",
] as const;

const RESEARCH_GUIDED_UX_INDEXES = [
  "idx_research_attachments_blob_pathname",
  "idx_research_attachments_session_key",
  "idx_research_attachments_session_created",
  "idx_research_attachments_turn_created",
  "idx_research_attachments_workspace_status",
  "idx_research_voice_events_session_provider",
  "idx_research_voice_events_session_created",
] as const;

const RESEARCH_BLOB_CLEANUP_INDEXES = [
  "idx_research_blob_cleanups_pathname",
  "idx_research_blob_cleanups_workspace_retry",
] as const;

type BackfillPreflight = {
  rowCount: number;
  estimatedBytes: number;
  estimateBasis: "conservative full source-row bytes";
  available: boolean;
  passed: boolean;
};

type ResearchCapturePreflight = {
  limits: typeof DSQL_WRITE_LIMITS;
  tokenBackfill: BackfillPreflight;
  nextSequenceBackfill: BackfillPreflight;
  passed: boolean;
};

function toSafeNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : Number.MAX_SAFE_INTEGER;
}

function backfillResult(
  row: { row_count?: unknown; estimated_bytes?: unknown } | undefined,
  available: boolean
): BackfillPreflight {
  const rowCount = available ? toSafeNumber(row?.row_count) : 0;
  const estimatedBytes = available ? toSafeNumber(row?.estimated_bytes) : 0;
  return {
    rowCount,
    estimatedBytes,
    estimateBasis: "conservative full source-row bytes",
    available,
    passed:
      available &&
      rowCount <= DSQL_WRITE_LIMITS.maxRows &&
      estimatedBytes <= DSQL_WRITE_LIMITS.maxBytes,
  };
}

async function getResearchCapturePreflight(
  client: PoolClient,
  schema: string
): Promise<ResearchCapturePreflight> {
  const { rows: tableRows } = await client.query<{ table_name: string }>(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = $1
       AND table_name IN ('research_studies', 'research_sessions')`,
    [schema]
  );
  const tables = new Set(tableRows.map((row) => row.table_name));

  const tokenRows = tables.has("research_studies")
    ? (
        await client.query<{ row_count: string; estimated_bytes: string }>(`
          SELECT
            COUNT(*)::bigint AS row_count,
            COALESCE(SUM(pg_column_size(rs)), 0)::bigint AS estimated_bytes
          FROM "${schema}".research_studies rs
          WHERE share_token_hash IS NOT NULL
            AND share_expires_at IS NOT NULL
        `)
      ).rows
    : [];

  let sequenceRows: { row_count: string; estimated_bytes: string }[] = [];
  if (tables.has("research_sessions")) {
    const { rows: columnRows } = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1
         FROM information_schema.columns
         WHERE table_schema = $1
           AND table_name = 'research_sessions'
           AND column_name = 'next_sequence'
       ) AS exists`,
      [schema]
    );
    const onlyMissing = columnRows[0]?.exists ? "WHERE next_sequence IS NULL" : "";
    sequenceRows = (
      await client.query<{ row_count: string; estimated_bytes: string }>(`
        SELECT
          COUNT(*)::bigint AS row_count,
          COALESCE(SUM(pg_column_size(rs)), 0)::bigint AS estimated_bytes
        FROM "${schema}".research_sessions rs
        ${onlyMissing}
      `)
    ).rows;
  }

  const tokenBackfill = backfillResult(tokenRows[0], tables.has("research_studies"));
  const nextSequenceBackfill = backfillResult(
    sequenceRows[0],
    tables.has("research_sessions")
  );

  return {
    limits: DSQL_WRITE_LIMITS,
    tokenBackfill,
    nextSequenceBackfill,
    passed: tokenBackfill.passed && nextSequenceBackfill.passed,
  };
}

async function getResearchCaptureIndexStatus(client: PoolClient, schema: string) {
  const { rows } = await client.query<{ name: string; valid: boolean }>(
    `SELECT c.relname AS name, i.indisvalid AS valid
     FROM pg_index i
     JOIN pg_class c ON c.oid = i.indexrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1
       AND c.relname = ANY($2::text[])`,
    [schema, [...RESEARCH_CAPTURE_INDEXES]]
  );
  const validity = new Map(rows.map((row) => [row.name, row.valid]));
  const indexes = RESEARCH_CAPTURE_INDEXES.map((name) => ({
    name,
    present: validity.has(name),
    valid: validity.get(name) === true,
  }));

  return {
    indexes,
    indexesValid: indexes.every((index) => index.valid),
  };
}

async function getNamedIndexStatus(
  client: PoolClient,
  schema: string,
  expected: readonly string[],
) {
  const { rows } = await client.query<{ name: string; valid: boolean }>(
    `SELECT c.relname AS name, i.indisvalid AS valid
     FROM pg_index i
     JOIN pg_class c ON c.oid = i.indexrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1
       AND c.relname = ANY($2::text[])`,
    [schema, [...expected]],
  )
  const validity = new Map(rows.map((row) => [row.name, row.valid]))
  const indexes = expected.map((name) => ({
    name,
    present: validity.has(name),
    valid: validity.get(name) === true,
  }))
  return { indexes, indexesValid: indexes.every((index) => index.valid) }
}

async function getResearchGuidedUxReport(client: PoolClient, schema: string, asyncIndexJobIds: string[] = []) {
  const indexStatus = await getNamedIndexStatus(client, schema, RESEARCH_GUIDED_UX_INDEXES)
  const asyncIndexJobs = await getAsyncIndexJobStatus(client, asyncIndexJobIds)
  return {
    preflight: {
      passed: true,
      writesExistingRows: false,
      reason: "Migration 037 adds nullable columns and new empty tables; it performs no backfill.",
    },
    ...indexStatus,
    asyncIndexJobs,
  }
}

async function getResearchBlobCleanupReport(client: PoolClient, schema: string, asyncIndexJobIds: string[] = []) {
  const indexStatus = await getNamedIndexStatus(client, schema, RESEARCH_BLOB_CLEANUP_INDEXES)
  const asyncIndexJobs = await getAsyncIndexJobStatus(client, asyncIndexJobIds)
  return {
    preflight: {
      passed: true,
      writesExistingRows: false,
      reason: "Migration 038 creates a new empty table and performs no backfill.",
    },
    ...indexStatus,
    asyncIndexJobs,
  }
}

async function getAsyncIndexJobStatus(client: PoolClient, jobIds: string[]) {
  if (jobIds.length === 0) {
    return {
      waited: false,
      jobIds,
      jobs: [] as { jobId: string; status: string; details: string | null; objectName: string | null }[],
      reason:
        "No CREATE INDEX ASYNC job IDs were created by this request. Poll this authenticated GET until indexesValid is true before enabling the feature.",
    };
  }

  const { rows } = await client.query<{
    job_id: string;
    status: string;
    details: string | null;
    object_name: string | null;
  }>(
    `SELECT job_id, status, details, object_name
     FROM sys.jobs
     WHERE job_id = ANY($1::text[])`,
    [jobIds]
  );
  const jobsById = new Map(rows.map((row) => [row.job_id, row]));
  const jobs = jobIds.map((jobId) => {
    const job = jobsById.get(jobId);
    return {
      jobId,
      status: job?.status ?? "unknown",
      details: job?.details ?? null,
      objectName: job?.object_name ?? null,
    };
  });

  return {
    waited: false,
    jobIds,
    jobs,
    reason:
      "The route has a 60-second execution limit, while an async index build may run longer. Poll this authenticated GET until indexesValid is true before enabling the feature.",
  };
}

async function getResearchCaptureHardeningReport(
  client: PoolClient,
  schema: string,
  asyncIndexJobIds: string[] = []
) {
  const [preflight, indexStatus] = await Promise.all([
    getResearchCapturePreflight(client, schema),
    getResearchCaptureIndexStatus(client, schema),
  ]);
  const asyncIndexJobs = await getAsyncIndexJobStatus(client, asyncIndexJobIds);

  return {
    preflight,
    ...indexStatus,
    asyncIndexJobs,
  };
}

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
    const [researchCaptureHardening, researchGuidedUx, researchBlobCleanup] = await Promise.all([
      getResearchCaptureHardeningReport(client, schema),
      getResearchGuidedUxReport(client, schema),
      getResearchBlobCleanupReport(client, schema),
    ]);

    return NextResponse.json({
      schema,
      appliedMigrations: rows.map((r) => r.name),
      manifest: MIGRATIONS.map((m) => m.name),
      researchCaptureHardening,
      researchGuidedUx,
      researchBlobCleanup,
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
  const researchCaptureAsyncIndexJobIds: string[] = [];
  const researchGuidedUxAsyncIndexJobIds: string[] = [];
  const researchBlobCleanupAsyncIndexJobIds: string[] = [];

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
      const [researchCaptureHardening, researchGuidedUx, researchBlobCleanup] = await Promise.all([
        getResearchCaptureHardeningReport(client, schema),
        getResearchGuidedUxReport(client, schema),
        getResearchBlobCleanupReport(client, schema),
      ]);
      return NextResponse.json({
        message: "Nothing to apply. All migrations up to date.",
        schema,
        researchCaptureHardening,
        researchGuidedUx,
        researchBlobCleanup,
      });
    }

    for (const migration of toRun) {
      log.push(`\nApplying: ${migration.name}`);

      if (migration.name === "036_research_capture_hardening") {
        const preflight = await getResearchCapturePreflight(client, schema);
        if (!preflight.passed) {
          const indexStatus = await getResearchCaptureIndexStatus(client, schema);
          return NextResponse.json(
            {
              error:
                "Migration 036 preflight failed Aurora DSQL's 3,000-row or 10 MiB write-transaction limit.",
              schema,
              researchCaptureHardening: {
                preflight,
                ...indexStatus,
                asyncIndexJobs: {
                  waited: false,
                  jobIds: [] as string[],
                  reason: "Migration 036 was not started, so there are no async index jobs.",
                },
              },
            },
            { status: 409 }
          );
        }
      }

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

      let pendingRoadmapCommitmentProvenanceBackfill = false;
      for (const stmt of statements) {
        try {
          // ASYNC is mandatory on DSQL and unsupported by local PostgreSQL.
          // DATABASE_URL is the worktree-bootstrap local-mode signal.
          const executableStmt = process.env.DATABASE_URL
            ? stmt.replace(/\bINDEX ASYNC\b/gi, "INDEX")
            : stmt;
          const result = await client.query<{ job_id?: string }>(executableStmt);
          if (
            migration.name === "039_native_decision_gates" &&
            /ALTER\s+COLUMN\s+"?now_commitment_provenance"?\s+SET\s+DEFAULT/i.test(executableStmt)
          ) {
            pendingRoadmapCommitmentProvenanceBackfill = true;
          } else if (
            migration.name === "039_native_decision_gates" &&
            pendingRoadmapCommitmentProvenanceBackfill &&
            /^COMMIT;?$/i.test(executableStmt.trim())
          ) {
            pendingRoadmapCommitmentProvenanceBackfill = false;
            await backfillRoadmapCommitmentProvenance(client, schema, log);
          }
          if (!process.env.DATABASE_URL && /CREATE\s+(?:UNIQUE\s+)?INDEX\s+ASYNC/i.test(stmt)) {
            const jobId = result.rows[0]?.job_id;
            if (jobId && migration.name === "036_research_capture_hardening") {
              researchCaptureAsyncIndexJobIds.push(jobId);
            } else if (jobId && migration.name === "037_research_guided_ux") {
              researchGuidedUxAsyncIndexJobIds.push(jobId);
            } else if (jobId && migration.name === "038_research_blob_cleanup") {
              researchBlobCleanupAsyncIndexJobIds.push(jobId);
            }
          }
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

    const researchCaptureHardening = await getResearchCaptureHardeningReport(
      client,
      schema,
      researchCaptureAsyncIndexJobIds
    );
    const researchGuidedUx = await getResearchGuidedUxReport(client, schema, researchGuidedUxAsyncIndexJobIds);
    const researchBlobCleanup = await getResearchBlobCleanupReport(client, schema, researchBlobCleanupAsyncIndexJobIds);
    return NextResponse.json({ message: log.join("\n"), schema, researchCaptureHardening, researchGuidedUx, researchBlobCleanup });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg, log: log.join("\n"), schema }, { status: 500 });
  } finally {
    client.release();
    await pool.end();
  }
}
