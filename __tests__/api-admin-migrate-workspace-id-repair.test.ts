/**
 * POST /api/admin/migrate {"action":"backfill-workspace-id"}: the repeatable, authenticated residual repair for
 * Solution/Objective rows that old instances insert with a NULL workspace_id after a receipted migration.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  repair: vi.fn(),
  applyMigrations: vi.fn(),
  end: vi.fn(),
}));

vi.mock("pg", () => ({ Pool: class { end = mocks.end } }));
vi.mock("@aws-sdk/dsql-signer", () => ({ DsqlSigner: class {} }));
vi.mock("@vercel/functions/oidc", () => ({ awsCredentialsProvider: vi.fn() }));
vi.mock("@/lib/schema", () => ({ getActiveSchema: () => "compass_preview" }));
vi.mock("@/lib/migrations/runner", () => ({
  getMigrationStatus: vi.fn(),
  applyMigrations: mocks.applyMigrations,
  normalizeConstraintDefinition: vi.fn(),
  getDecisionGateExpectedCatalog: vi.fn(),
  getDecisionGateInfrastructureHealth: vi.fn(),
}));
vi.mock("@/lib/migrations/workspace-id-on-solution-objective", () => ({ repairWorkspaceIdResidual: mocks.repair }));

import { POST } from "@/app/api/admin/migrate/route";

const ORIGINAL = { ...process.env };
const post = (body: unknown, secret: string | null = "s3cret") =>
  POST(new NextRequest("http://localhost/api/admin/migrate", {
    method: "POST",
    headers: { "content-type": "application/json", ...(secret ? { "x-migration-secret": secret } : {}) },
    body: JSON.stringify(body),
  }));

beforeEach(() => {
  vi.clearAllMocks();
  process.env = { ...ORIGINAL, MIGRATION_SECRET: "s3cret", DATABASE_URL: "postgres://localhost/x" };
  delete process.env.PREVIEW_DATABASE_MODE;
  delete process.env.VERCEL_ENV;
  mocks.applyMigrations.mockResolvedValue(NextResponse.json({ message: "applied" }));
});
afterEach(() => { process.env = { ...ORIGINAL }; });

describe("backfill-workspace-id action", () => {
  it("requires the migration secret", async () => {
    expect((await post({ action: "backfill-workspace-id" }, null)).status).toBe(401);
    expect((await post({ action: "backfill-workspace-id" }, "wrong")).status).toBe(401);
    expect(mocks.repair).not.toHaveBeenCalled();
  });

  it("runs the repair against the active schema and returns before/after counts, never going through the migration runner", async () => {
    const result = { before: { nullWorkspaceId: { solutions: 2, objectives: 0 } }, log: ["  ✓ backfilled 2 solutions.workspace_id rows"], after: { nullWorkspaceId: { solutions: 0, objectives: 0 } } };
    mocks.repair.mockResolvedValue(result);
    const response = await post({ action: "backfill-workspace-id" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ schema: "compass_preview", ...result });
    expect(mocks.repair).toHaveBeenCalledWith(expect.anything(), "compass_preview");
    expect(mocks.applyMigrations).not.toHaveBeenCalled();
    expect(mocks.end).toHaveBeenCalled();
  });

  it("is repeatable", async () => {
    mocks.repair.mockResolvedValue({ before: {}, log: [], after: {} });
    expect((await post({ action: "backfill-workspace-id" })).status).toBe(200);
    expect((await post({ action: "backfill-workspace-id" })).status).toBe(200);
    expect(mocks.repair).toHaveBeenCalledTimes(2);
  });

  it("fails closed with 409, the error, before-counts and the log when a postcondition fails", async () => {
    mocks.repair.mockRejectedValue(Object.assign(new Error("backfill-workspace-id: backfill postcondition failed: 1 solutions rows still have NULL workspace_id"), { before: { orphans: { solutions: 1 } }, log: ["  ✓ backfilled 0 solutions.workspace_id rows"] }));
    const response = await post({ action: "backfill-workspace-id" });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ schema: "compass_preview", error: expect.stringContaining("postcondition failed"), before: { orphans: { solutions: 1 } } });
    expect(mocks.end).toHaveBeenCalled();
  });

  it("ordinary script POSTs still go to the runner", async () => {
    await post({ script: "069_workspace_id_residual_backfill" });
    expect(mocks.applyMigrations).toHaveBeenCalledWith(expect.anything(), "compass_preview", "069_workspace_id_residual_backfill");
    expect(mocks.repair).not.toHaveBeenCalled();
  });
});
