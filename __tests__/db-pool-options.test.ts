import { describe, expect, it } from "vitest";
import { getPlainPoolOptions } from "@/lib/db";
import { getMigrationDatabaseUrl, getPoolerMode, getRuntimeDatabaseUrl, normalizeIntegrationUrl, usesPlainPostgres } from "@/lib/db-url";

describe("getPlainPoolOptions", () => {
  const url = "postgres://u:p@host:5432/postgres";
  const txUrl = "postgres://u:p@host:6543/postgres";

  it("caps the per-instance pool low by default", () => {
    expect(getPlainPoolOptions(url, {})).toEqual({
      connectionString: url,
      max: 3,
      idleTimeoutMillis: 10_000,
    });
  });

  it("uses a slightly higher default cap on the transaction pooler", () => {
    expect(getPlainPoolOptions(txUrl, {}).max).toBe(5);
  });

  it("honours DATABASE_POOL_MAX in both modes", () => {
    expect(getPlainPoolOptions(url, { DATABASE_POOL_MAX: "8" }).max).toBe(8);
    expect(getPlainPoolOptions(txUrl, { DATABASE_POOL_MAX: "2" }).max).toBe(2);
  });

  it.each(["", "0", "-2", "abc", "1.5x"])("ignores invalid DATABASE_POOL_MAX %j", (value) => {
    expect(getPlainPoolOptions(url, { DATABASE_POOL_MAX: value }).max).toBe(3);
    expect(getPlainPoolOptions(txUrl, { DATABASE_POOL_MAX: value }).max).toBe(5);
  });
});

describe("database URL selection", () => {
  it("uses DATABASE_URL for runtime and migrations when only it is set", () => {
    const env = { DATABASE_URL: "postgres://a:5432/db" };
    expect(getRuntimeDatabaseUrl(env)).toBe(env.DATABASE_URL);
    expect(getMigrationDatabaseUrl(env)).toBe(env.DATABASE_URL);
  });

  it("prefers DATABASE_MIGRATION_URL for migrations without changing runtime", () => {
    const env = { DATABASE_URL: "postgres://a:6543/db", DATABASE_MIGRATION_URL: "postgres://a:5432/db" };
    expect(getRuntimeDatabaseUrl(env)).toBe(env.DATABASE_URL);
    expect(getMigrationDatabaseUrl(env)).toBe(env.DATABASE_MIGRATION_URL);
  });

  it("treats blank values as unset", () => {
    const env = { DATABASE_URL: " ", DATABASE_MIGRATION_URL: "" };
    expect(getRuntimeDatabaseUrl(env)).toBeUndefined();
    expect(getMigrationDatabaseUrl(env)).toBeUndefined();
  });
});

describe("Vercel Supabase integration fallbacks", () => {
  const pooled = "postgres://u:p@aws-0.pooler.supabase.com:6543/postgres?sslmode=require&supa=base-pooler.x";
  const direct = "postgres://u:p@db.ref.supabase.co:5432/postgres?sslmode=require";

  it("runtime prefers DATABASE_URL over POSTGRES_URL", () => {
    expect(getRuntimeDatabaseUrl({ DATABASE_URL: "postgres://x:5432/db", POSTGRES_URL: pooled })).toBe("postgres://x:5432/db");
  });

  it("runtime falls through to a normalized POSTGRES_URL", () => {
    const url = getRuntimeDatabaseUrl({ POSTGRES_URL: pooled })!;
    expect(url).toContain(":6543/");
    expect(url).not.toContain("supa=");
    expect(url).toContain("sslmode=require");
    expect(url).toContain("uselibpqcompat=true");
    expect(getPoolerMode(url, {})).toBe("transaction");
  });

  it("migrations prefer DATABASE_MIGRATION_URL, then POSTGRES_URL_NON_POOLING, then the runtime URL", () => {
    const base = { DATABASE_URL: "postgres://rt:5432/db", POSTGRES_URL: pooled, POSTGRES_URL_NON_POOLING: direct };
    expect(getMigrationDatabaseUrl({ ...base, DATABASE_MIGRATION_URL: "postgres://m:5432/db" })).toBe("postgres://m:5432/db");
    expect(getMigrationDatabaseUrl(base)).toContain("db.ref.supabase.co");
    expect(getMigrationDatabaseUrl({ DATABASE_URL: "postgres://rt:5432/db" })).toBe("postgres://rt:5432/db");
    expect(getPoolerMode(getMigrationDatabaseUrl({ POSTGRES_URL: pooled })!, {})).toBe("transaction");
  });

  it("does not alter an explicit DATABASE_URL", () => {
    const explicit = "postgres://x:5432/db?sslmode=require";
    expect(getRuntimeDatabaseUrl({ DATABASE_URL: explicit })).toBe(explicit);
  });

  it("only adds libpq semantics for bare sslmode=require", () => {
    expect(normalizeIntegrationUrl("postgres://h:6543/d?sslmode=verify-full")).not.toContain("uselibpqcompat");
    expect(normalizeIntegrationUrl("postgres://h:6543/d?sslmode=require&sslrootcert=/ca.pem")).not.toContain("uselibpqcompat");
    expect(normalizeIntegrationUrl("not a url")).toBe("not a url");
  });

  it("ignores integration and migration variables in automation previews", () => {
    for (const env of [{ PREVIEW_AUTOMATION_ENABLED: "1" }, { PREVIEW_DATABASE_MODE: "vercel-managed" }]) {
      const withVars = { ...env, POSTGRES_URL: pooled, POSTGRES_URL_NON_POOLING: direct, DATABASE_MIGRATION_URL: direct };
      expect(getRuntimeDatabaseUrl(withVars)).toBeUndefined();
      expect(getMigrationDatabaseUrl(withVars)).toBeUndefined();
      expect(usesPlainPostgres(withVars)).toBe(false);
    }
  });

  it("usesPlainPostgres is true for DATABASE_URL or integration vars, false otherwise", () => {
    expect(usesPlainPostgres({ DATABASE_URL: "postgres://x/db" })).toBe(true);
    expect(usesPlainPostgres({ POSTGRES_URL: pooled })).toBe(true);
    expect(usesPlainPostgres({ PGHOST: "dsql" })).toBe(false);
  });
});

describe("getPoolerMode", () => {
  it("detects the Supabase transaction pooler by port", () => {
    expect(getPoolerMode("postgres://u:p@h:6543/postgres", {})).toBe("transaction");
    expect(getPoolerMode("postgres://u:p@h:5432/postgres", {})).toBe("session");
    expect(getPoolerMode("postgres://u:p@h/postgres", {})).toBe("session");
  });

  it("lets DATABASE_POOLER_MODE override detection", () => {
    expect(getPoolerMode("postgres://u:p@h:5432/postgres", { DATABASE_POOLER_MODE: "Transaction" })).toBe("transaction");
    expect(getPoolerMode("postgres://u:p@h:6543/postgres", { DATABASE_POOLER_MODE: "session" })).toBe("session");
  });

  it("falls back to session for an unparseable URL", () => {
    expect(getPoolerMode("not a url", {})).toBe("session");
  });
});
