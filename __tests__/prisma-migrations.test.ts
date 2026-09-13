import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";

/**
 * Guards the DDL that actually reaches Aurora DSQL.
 *
 * schema.prisma is NOT the deploy mechanism for this project — `/api/admin/migrate`
 * reads the hand-written SQL files registered in its MIGRATIONS manifest. That
 * split has two failure modes these tests exist to catch:
 *
 *  1. Indexes added to schema.prisma with no matching migration file, so they
 *     silently never get created in preview/production.
 *  2. SQL that is valid PostgreSQL but invalid Aurora DSQL, which only blows up
 *     at deploy time. DSQL's CREATE INDEX grammar is:
 *       CREATE [UNIQUE] INDEX ASYNC [[IF NOT EXISTS] name] ON table
 *         ({column | (expr)} [NULLS {FIRST|LAST}] [, ...]) [INCLUDE (...)]
 *         [NULLS [NOT] DISTINCT]
 *     Note there is no ASC/DESC, and ASYNC is mandatory.
 */

const ROOT = process.cwd();
const MIGRATIONS_DIR = path.join(ROOT, "prisma/migrations");
const ROUTE = path.join(ROOT, "lib/migrations/runner.ts");

/** Names registered in the migrate route's MIGRATIONS manifest, in order. */
function registeredMigrations(): string[] {
  const src = readFileSync(ROUTE, "utf-8");
  return [...src.matchAll(/name:\s*"([^"]+)"/g)].map((m) => m[1]);
}

it("preserves independently deployed PM and main migrations sharing numeric prefixes", () => {
  const names = registeredMigrations()
  for (const name of ["050_pm_interviews", "050_experiment_not_pursued", "051_pm_agent_handoff", "051_decision_task_bridge"]) {
    expect(names.filter(item => item === name)).toHaveLength(1)
    expect(existsSync(path.join(MIGRATIONS_DIR, name, "migration.sql"))).toBe(true)
  }
  expect(names.indexOf("050_pm_interviews")).toBeLessThan(names.indexOf("051_pm_agent_handoff"))
})

/** Migration directories on disk that contain a migration.sql. */
function migrationDirsOnDisk(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => existsSync(path.join(MIGRATIONS_DIR, name, "migration.sql")))
    .sort();
}

/** Strip `-- ...` line comments so prose can't be mistaken for SQL. */
function stripComments(sql: string): string {
  return sql
    .split("\n")
    .map((line) => line.replace(/--.*$/, "").trimEnd())
    .join("\n");
}

function sqlFor(name: string): string {
  return stripComments(readFileSync(path.join(MIGRATIONS_DIR, name, "migration.sql"), "utf-8"));
}

const registered = registeredMigrations();
const onDisk = migrationDirsOnDisk();

describe("migration manifest", () => {
  it("registers every migration that exists on disk", () => {
    // Catches the "wrote the SQL, forgot to add it to the route" mistake, which
    // fails silently — the indexes simply never get created.
    const missing = onDisk.filter((d) => !registered.includes(d));
    expect(missing).toEqual([]);
  });

  it("points every registered migration at a file that exists", () => {
    const broken = registered.filter(
      (name) => !existsSync(path.join(MIGRATIONS_DIR, name, "migration.sql"))
    );
    expect(broken).toEqual([]);
  });

  it("has no duplicate entries", () => {
    expect(registered).toEqual([...new Set(registered)]);
  });
});

describe("Aurora DSQL DDL constraints", () => {
  it.each(registered)("%s uses CREATE INDEX ASYNC everywhere", (name) => {
    const sql = sqlFor(name);
    // Any CREATE [UNIQUE] INDEX not immediately followed by ASYNC is invalid on DSQL.
    const bad = [...sql.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?!ASYNC\b)(\S+)/gi)].map(
      (m) => m[0].replace(/\s+/g, " ")
    );
    expect(bad).toEqual([]);
  });

  it.each(registered)("%s declares no ASC/DESC sort direction in an index", (name) => {
    const sql = sqlFor(name);
    const statements = sql.split(/;\s*\n/).filter((s) => /CREATE\s+(UNIQUE\s+)?INDEX/i.test(s));
    const offending = statements
      .filter((s) => /\b(ASC|DESC)\b/i.test(s))
      .map((s) => s.trim().replace(/\s+/g, " ").slice(0, 90));
    // DSQL's CREATE INDEX grammar has no sort direction — only NULLS FIRST|LAST.
    expect(offending).toEqual([]);
  });
});

describe("PM interview migration (050)", () => {
  const sql = sqlFor("050_pm_interviews");
  const runner = readFileSync(ROUTE, "utf-8");

  it("is registered with additive, retry-safe DDL", () => {
    expect(registered).toContain("050_pm_interviews");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS description TEXT");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS pm_interviews");
    expect(sql.match(/CREATE (?:UNIQUE )?INDEX ASYNC IF NOT EXISTS/g)).toHaveLength(6);
  });

  it("can resume after a timed-out async index wait and verifies the full catalog before receipt", () => {
    expect(runner).toContain('["049_agent_identity", "050_pm_interviews", "051_pm_agent_handoff"].includes(migration.name)');
    expect(runner).toContain("to_regclass(format('%I.pm_interviews', $1::text))")
    expect(runner).toContain('if (migration.name === "050_pm_interviews") await assertPmInterviewPostconditions(client, schema)');
    expect(runner.indexOf('if (migration.name === "050_pm_interviews") await assertPmInterviewPostconditions')).toBeLessThan(
      runner.indexOf('UPDATE "${schema}"._prisma_migrations SET finished_at = CURRENT_TIMESTAMP'),
    );
  });
});

describe("feedback grid indexes (033)", () => {
  const sql = sqlFor("033_feedback_grid_indexes");

  it("is registered", () => {
    expect(registered).toContain("033_feedback_grid_indexes");
  });

  it("creates exactly the five indexes the grid's query shapes need", () => {
    const names = [...sql.matchAll(/CREATE\s+INDEX\s+ASYNC\s+(\w+)\s+ON\s+(\w+)\s*\(([^)]*)\)/gi)].map(
      (m) => ({ index: m[1], table: m[2], cols: m[3].split(",").map((c) => c.trim()) })
    );

    expect(names).toEqual([
      {
        index: "feedback_workspace_id_vote_count_created_at_idx",
        table: "feedback",
        cols: ["workspace_id", "vote_count", "created_at"],
      },
      {
        index: "feedback_workspace_id_status_idx",
        table: "feedback",
        cols: ["workspace_id", "status"],
      },
      {
        index: "feedback_workspace_id_type_idx",
        table: "feedback",
        cols: ["workspace_id", "type"],
      },
      {
        index: "feedback_workspace_id_created_at_idx",
        table: "feedback",
        cols: ["workspace_id", "created_at"],
      },
      {
        index: "feedback_opportunity_id_idx",
        table: "feedback",
        cols: ["opportunity_id"],
      },
    ]);
  });

  it("uses index names matching Prisma's default convention, so schema.prisma reports no drift", () => {
    // Prisma names an index <table>_<col1>_<col2>_idx. If these drift, a future
    // `prisma migrate diff` will think the indexes are missing and try to re-add them.
    const names = [...sql.matchAll(/CREATE\s+INDEX\s+ASYNC\s+(\w+)\s+ON\s+(\w+)\s*\(([^)]*)\)/gi)];
    for (const m of names) {
      const expected = `${m[2]}_${m[3].split(",").map((c) => c.trim()).join("_")}_idx`;
      expect(m[1]).toBe(expected);
    }
  });
});

describe("research capture hardening migration (036)", () => {
  const sql = sqlFor("036_research_capture_hardening");

  it("is registered and creates the additive token, request, session, and credential fields", () => {
    expect(registered).toContain("036_research_capture_hardening");
    expect(sql).toContain("CREATE TABLE research_participant_tokens")
    expect(sql).toContain("CREATE TABLE research_requests")
    expect(sql).toContain("ALTER TABLE research_sessions ADD COLUMN IF NOT EXISTS resume_token_hash")
    expect(sql).toContain("ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS expires_at")
  });

  it("backfills participant tokens before creating the unique token index", () => {
    const backfill = sql.indexOf("INSERT INTO research_participant_tokens")
    const uniqueIndex = sql.indexOf("CREATE UNIQUE INDEX ASYNC idx_research_participant_tokens_hash")
    expect(backfill).toBeGreaterThan(-1)
    expect(uniqueIndex).toBeGreaterThan(backfill)
    expect(sql).toContain("NOT EXISTS")
    expect(sql).not.toContain("ON CONFLICT")
  });

  it("keeps additive sequence state nullable without a DSQL-incompatible default change", () => {
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS next_sequence INTEGER")
    expect(sql).not.toMatch(/ALTER COLUMN next_sequence SET (?:DEFAULT|NOT NULL)/i)
  });

  it("uses index names mapped by the Prisma schema", () => {
    const schema = readFileSync(path.join(ROOT, "prisma/schema.prisma"), "utf-8");
    for (const name of [
      "idx_research_participant_tokens_hash",
      "idx_research_sessions_resume_token",
      "idx_research_sessions_participant_token",
      "idx_research_requests_session_key",
    ]) {
      expect(sql).toContain(name)
      expect(schema).toContain(`map: "${name}"`)
    }
  });
});

describe("authoritative research voice control plane migration (047)", () => {
  const migrationName = "047_research_voice_control_plane";

  it("is registered and creates the additive call and command stores", () => {
    expect(registered).toContain(migrationName);
    const sql = sqlFor(migrationName);

    expect(sql).toContain("CREATE TABLE research_voice_calls");
    expect(sql).toContain("CREATE TABLE research_voice_commands");
    expect(sql).not.toMatch(/FOREIGN\s+KEY/i);
  });

  it("adds durable quota, transcript, and provider-ordering fields", () => {
    const sql = sqlFor(migrationName);

    for (const column of ["voice_attempt_count", "voice_turn_count", "voice_transcript_chars"]) {
      expect(sql).toContain(`ALTER TABLE research_sessions ADD COLUMN IF NOT EXISTS ${column}`);
    }
    for (const column of ["voice_window_at", "voice_count", "voice_day_at", "voice_day_count"]) {
      expect(sql).toContain(`ALTER TABLE research_participant_tokens ADD COLUMN IF NOT EXISTS ${column}`);
    }
    for (const column of [
      "voice_call_id",
      "provider_item_id",
      "provider_response_id",
      "provider_previous_item_id",
      "provider_ordinal",
      "provider_status",
    ]) {
      expect(sql).toContain(`ALTER TABLE research_voice_events ADD COLUMN IF NOT EXISTS ${column}`);
    }
    const route = readFileSync(ROUTE, "utf-8")
    expect(route).toContain("RESEARCH_VOICE_BACKFILL_BATCH_SIZE = 2_500")
    expect(route).toContain("backfillNullableResearchVoiceColumn")
    for (const column of ["voice_turn_count", "voice_transcript_chars"]) {
      expect(route).toContain(column)
    }
    expect(route).toContain("LIMIT $1")
    expect(route).toContain("result.rowCount < RESEARCH_VOICE_BACKFILL_BATCH_SIZE")
    expect(route).toContain("COUNT(*)::INTEGER FROM \"${schema}\".research_turns")
    expect(route).toContain("SUM(char_length(content))::INTEGER FROM \"${schema}\".research_turns")
    expect(route).toContain("modality = 'VOICE'")
    expect(sql).toContain("next_provider_ordinal INTEGER NOT NULL DEFAULT 0")
    expect(sql).toContain("last_provider_item_id VARCHAR(255)")
    expect(sql).toContain("status_changed_at TIMESTAMPTZ NOT NULL DEFAULT now()")
    for (const column of [
      "command_pending_count INTEGER NOT NULL DEFAULT 0",
      "command_total_count INTEGER NOT NULL DEFAULT 0",
      "command_window_at TIMESTAMPTZ",
      "command_window_count INTEGER NOT NULL DEFAULT 0",
      "hangup_command_id UUID",
      "canonical_command_id UUID",
    ]) expect(sql).toContain(column)
  });

  it("uses one statement per transaction and async indexes", () => {
    const raw = readFileSync(path.join(MIGRATIONS_DIR, migrationName, "migration.sql"), "utf-8");
    const ddlStatements = stripComments(raw)
      .split(";")
      .map((statement) => statement.trim())
      .filter((statement) => /^(?:CREATE|ALTER)\s/i.test(statement));

    expect(ddlStatements.length).toBeGreaterThan(0);
    expect(raw).not.toMatch(/BEGIN;[\s\S]*?\b(?:CREATE|ALTER)\b[\s\S]*?\b(?:CREATE|ALTER)\b[\s\S]*?COMMIT;/i);
    expect(raw).not.toMatch(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?!ASYNC\b)/i);
  });

  it("declares every uniqueness and lookup index required by the control plane", () => {
    const sql = sqlFor(migrationName);
    for (const index of [
      "idx_research_voice_calls_session_key",
      "idx_research_voice_calls_provider_call",
      "idx_research_voice_calls_worker_token",
      "idx_research_voice_calls_session_status",
      "idx_research_voice_calls_status_lease",
      "idx_research_voice_calls_status_heartbeat",
      "idx_research_voice_calls_participant_token",
      "idx_research_voice_commands_call_key",
      "idx_research_voice_commands_call_status_created",
      "idx_research_voice_commands_session",
      "idx_research_voice_events_call_provider",
      "idx_research_voice_events_call_ordinal",
      "idx_research_voice_events_call_item",
    ]) {
      expect(sql).toContain(index);
    }
  });

  it("waits for every remote async index and verifies catalog readiness before completion", () => {
    const route = readFileSync(ROUTE, "utf-8")
    expect(route).toMatch(/ASYNC_WAIT_MIGRATIONS = \[\.\.\.DECISION_GATE_MIGRATIONS, "047_research_voice_control_plane"(?:, "[^"]+")*\]/)
    expect(route).toContain("async DDL returned no job_id")
    expect(route).toContain("CALL sys.wait_for_job($1)")
    expect(route).not.toContain("SELECT sys.wait_for_job")
    expect(route).toContain("assertResearchVoiceControlPlanePostconditions")
    expect(route).toContain("researchVoiceControlPlane")
  })
});

describe("schema.prisma stays DSQL-compatible", () => {
  it("declares no sort: Desc on any @@index", () => {
    // Prisma turns `sort: Desc` into `("col" DESC)`, which DSQL rejects.
    const schema = readFileSync(path.join(ROOT, "prisma/schema.prisma"), "utf-8");
    const offending = schema
      .split("\n")
      .filter((l) => /@@index/.test(l) && /sort:\s*Desc/i.test(l))
      .map((l) => l.trim());
    expect(offending).toEqual([]);
  });

  it("keeps capacity plans DRAFT until reconciliation explicitly activates them", () => {
    const schema = readFileSync(path.join(ROOT, "prisma/schema.prisma"), "utf-8");
    const migration = sqlFor("041_portfolio_capacity_ledger");
    const planModel = schema.match(/model PortfolioCapacityPlan \{[\s\S]*?\n\}/)?.[0] ?? "";
    const planTable = migration.match(/CREATE TABLE IF NOT EXISTS "portfolio_capacity_plans" \([\s\S]*?\n\);/)?.[0] ?? "";

    expect(planModel).toContain('state           String                         @default("DRAFT")');
    expect(planTable).toContain('"state" VARCHAR(30) NOT NULL DEFAULT \'DRAFT\'');
    expect(planTable).not.toContain('"state" VARCHAR(30) NOT NULL DEFAULT \'ACTIVE\'');
  });
});
