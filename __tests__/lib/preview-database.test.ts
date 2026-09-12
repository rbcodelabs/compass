import { afterEach, describe, expect, it, vi } from "vitest";

// Partial mock: only the constructor is stubbed. lib/db.ts also reads the real
// `Prisma.dmmf` at module scope (to derive which models carry `updatedAt`), so a
// mock that returns PrismaClient alone makes the import itself throw. Neither
// assertion below touches dmmf — both run before any client is constructed.
vi.mock("@prisma/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@prisma/client")>()),
  PrismaClient: vi.fn(),
}));
vi.mock("@prisma/adapter-pg", () => ({ PrismaPg: vi.fn() }));
vi.mock("pg", () => ({ Pool: vi.fn() }));
import { createPrismaClient, getDatabaseUser } from "@/lib/db";

describe("preview database connection boundary", () => {
  afterEach(() => vi.unstubAllEnvs());
  function preview() {
    vi.stubEnv("PREVIEW_AUTOMATION_ENABLED", "1");
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("VERCEL_GIT_PULL_REQUEST_ID", "156");
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "a".repeat(40));
  }
  it("rejects a connection URL that could bypass the scoped runtime role", () => {
    preview();
    vi.stubEnv("DATABASE_URL", "postgresql://admin@localhost/postgres");
    expect(() => createPrismaClient()).toThrow(/DATABASE_URL/);
  });
  it("ignores the legacy admin default and derives the scoped revision role", () => {
    preview();
    vi.stubEnv("DATABASE_URL", "");
    vi.stubEnv("PGUSER", "admin");
    expect(getDatabaseUser()).toBe("compass_pr_156_aaaaaaaaaaaa_runtime");
  });
});
