import { describe, expect, it } from "vitest";
import { getPlainPoolOptions } from "@/lib/db";
import { getMigrationDatabaseUrl, getPoolerMode, getRuntimeDatabaseUrl } from "@/lib/db-url";

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
