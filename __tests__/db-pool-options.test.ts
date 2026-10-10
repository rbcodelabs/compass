import { describe, expect, it } from "vitest";
import { getPlainPoolOptions } from "@/lib/db";

describe("getPlainPoolOptions", () => {
  const url = "postgres://u:p@host:5432/postgres";

  it("caps the per-instance pool low by default", () => {
    expect(getPlainPoolOptions(url, {})).toEqual({
      connectionString: url,
      max: 3,
      idleTimeoutMillis: 10_000,
    });
  });

  it("honours DATABASE_POOL_MAX", () => {
    expect(getPlainPoolOptions(url, { DATABASE_POOL_MAX: "8" }).max).toBe(8);
  });

  it.each(["", "0", "-2", "abc", "1.5x"])("ignores invalid DATABASE_POOL_MAX %j", (value) => {
    const max = getPlainPoolOptions(url, { DATABASE_POOL_MAX: value }).max;
    expect(max).toBe(3);
  });
});
