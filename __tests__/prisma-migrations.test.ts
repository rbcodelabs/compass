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
const ROUTE = path.join(ROOT, "app/api/admin/migrate/route.ts");

/** Names registered in the migrate route's MIGRATIONS manifest, in order. */
function registeredMigrations(): string[] {
  const src = readFileSync(ROUTE, "utf-8");
  return [...src.matchAll(/name:\s*"([^"]+)"/g)].map((m) => m[1]);
}

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
});
