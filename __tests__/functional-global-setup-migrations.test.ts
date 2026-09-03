import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  release: vi.fn(),
  connect: vi.fn(),
  end: vi.fn(),
  mkdir: vi.fn(),
  writeFile: vi.fn(),
}));

vi.mock("pg", () => ({
  default: {
    Pool: class MockPool {
      connect = mocks.connect;
      query = mocks.query;
      end = mocks.end;
    },
  },
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    default: { ...actual, mkdir: mocks.mkdir, writeFile: mocks.writeFile },
    mkdir: mocks.mkdir,
    writeFile: mocks.writeFile,
  };
});

vi.mock("@/e2e/functional/fixtures/seed-e2e", () => ({
  seedE2E: vi.fn().mockResolvedValue({ nowCommitmentPolicy: {} }),
}));

vi.mock("@/e2e/functional/fixtures/run-token", () => ({
  setRunToken: vi.fn(),
}));

import globalSetup from "@/e2e/functional/global-setup";

const ORIGINAL_ENV = { ...process.env };

describe("functional E2E migration setup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DATABASE_URL = "postgresql://localhost/compass_e2e";
    process.env.E2E_ISOLATED_DATABASE = "1";
    mocks.connect.mockResolvedValue({ query: mocks.query, release: mocks.release });
    mocks.end.mockResolvedValue(undefined);
    vi.spyOn(process, "loadEnvFile").mockImplementation(() => {
      throw new Error("test fixture has no env file");
    });

    let provenanceReads = 0;
    let provenanceBackfilled = false;
    mocks.query.mockImplementation(async (sqlValue: unknown) => {
      const sql = String(sqlValue);
      if (sql.includes("e2e_database_sentinel")) {
        return { rows: [{ value: "compass-authenticated-e2e" }] };
      }
      if (sql.includes("SELECT id") && sql.includes("now_commitment_provenance IS NULL")) {
        provenanceReads += 1;
        return provenanceReads === 1
          ? { rows: [{ id: "00000000-0000-4000-8000-000000000039", estimated_bytes: "128" }] }
          : { rows: [] };
      }
      if (sql.includes("now_commitment_provenance = 'LEGACY_UNGATED'")) {
        provenanceBackfilled = true;
        return { rows: [], rowCount: 1 };
      }
      if (/SET\s+NOT\s+NULL/i.test(sql) && sql.includes("now_commitment_provenance") && !provenanceBackfilled) {
        throw new Error("column now_commitment_provenance of relation roadmap_items contains null values");
      }
      return { rows: [] };
    });
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
  });

  it("backfills preexisting roadmap rows before migration 039 sets NOT NULL", async () => {
    await expect(globalSetup()).resolves.toBeUndefined();

    const statements = mocks.query.mock.calls.map(([sql]) => String(sql));
    const setDefaultCommitIndex = statements.findIndex(
      (sql, index) =>
        index > statements.findIndex((candidate) => /now_commitment_provenance"?\s+SET\s+DEFAULT/i.test(candidate)) &&
        /^COMMIT;?$/i.test(sql.trim()),
    );
    const backfillIndex = statements.findIndex((sql) =>
      sql.includes("now_commitment_provenance = 'LEGACY_UNGATED'"),
    );
    const validateConstraintIndex = statements.findIndex((sql) =>
      /VALIDATE\s+CONSTRAINT\s+"chk_roadmap_items_commitment_provenance_not_null"/i.test(sql),
    );

    expect(setDefaultCommitIndex).toBeGreaterThan(-1);
    expect(backfillIndex).toBeGreaterThan(setDefaultCommitIndex);
    expect(validateConstraintIndex).toBeGreaterThan(backfillIndex);
  });
});
