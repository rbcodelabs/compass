import { spawnSync } from "node:child_process";
import { expect, test, vi } from "vitest";

vi.mock("pg", () => ({
  default: { Pool: class { async query() {} async end() {} } },
}));
vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));

test("db push uses the validated fixture even when inherited migration URLs conflict", async () => {
  const fixture = "postgresql://localhost/compass_e2e";
  vi.stubEnv("DATABASE_URL", fixture);
  vi.stubEnv("E2E_ISOLATED_DATABASE", "1");
  vi.stubEnv("DATABASE_MIGRATION_URL", "postgresql://migration.invalid/other");
  vi.stubEnv("POSTGRES_URL_NON_POOLING", "postgresql://direct.invalid/other");
  const intercepted = new Error("intercepted Prisma subprocess");
  vi.mocked(spawnSync).mockImplementationOnce(() => { throw intercepted; });
  try {
    await expect(import("../scripts/prepare-e2e-database.mjs")).rejects.toBe(intercepted);
    const env = vi.mocked(spawnSync).mock.calls[0][2]?.env;
    const target = fixture + "?schema=compass_dev";
    expect(env).toMatchObject({
      DATABASE_URL: target,
      DATABASE_MIGRATION_URL: target,
      POSTGRES_URL_NON_POOLING: target,
    });
  } finally {
    vi.unstubAllEnvs();
  }
});
