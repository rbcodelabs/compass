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
vi.mock("@/lib/migrations/workspace-id-on-solution-objective", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/migrations/workspace-id-on-solution-objective")>()),
  repairWorkspaceIdResidual: mocks.repair,
}));

import { POST } from "@/app/api/admin/migrate/route";
import { WorkspaceIdBackfillRefusal } from "@/lib/migrations/workspace-id-on-solution-objective";

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
    mocks.repair.mockRejectedValue(Object.assign(new WorkspaceIdBackfillRefusal("backfill-workspace-id: backfill postcondition failed: 1 solutions rows still have NULL workspace_id"), { before: { orphans: { solutions: 1 } }, log: ["  ✓ backfilled 0 solutions.workspace_id rows"] }));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const response = await post({ action: "backfill-workspace-id" });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ schema: "compass_preview", error: expect.stringContaining("postcondition failed"), before: { orphans: { solutions: 1 } } });
    expect(mocks.end).toHaveBeenCalled();
    expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({ event: "workspace-id-backfill", outcome: "refused", schema: "compass_preview" });
    log.mockRestore();
  });

  it("returns 500 (not 409) for a server fault, without leaking internals, and logs it", async () => {
    mocks.repair.mockRejectedValue(Object.assign(new Error("connect ECONNREFUSED 10.0.0.5:5432 password=hunter2"), { before: { columnsPresent: true } }));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await post({ action: "backfill-workspace-id" });
    expect(response.status).toBe(500);
    const text = JSON.stringify(await response.json());
    expect(text).toContain("idempotent");
    expect(text).not.toMatch(/ECONNREFUSED|hunter2|10\.0\.0\.5/);
    expect(JSON.parse(error.mock.calls[0][0])).toMatchObject({ event: "workspace-id-backfill", outcome: "error" });
    expect(error.mock.calls[0][0]).not.toMatch(/hunter2|ECONNREFUSED/);
    expect(mocks.end).toHaveBeenCalled();
    error.mockRestore();
  });

  it("logs one structured line on success with counts only (no receipt is written, so this is the audit trail)", async () => {
    mocks.repair.mockResolvedValue({ before: { nullWorkspaceId: { solutions: 2, objectives: 0 } }, log: ["  ✓ backfilled 2 solutions.workspace_id rows"], after: { nullWorkspaceId: { solutions: 0, objectives: 0 } } });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await post({ action: "backfill-workspace-id" });
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(log.mock.calls[0][0])).toEqual({ event: "workspace-id-backfill", outcome: "ok", schema: "compass_preview", before: { nullWorkspaceId: { solutions: 2, objectives: 0 } }, after: { nullWorkspaceId: { solutions: 0, objectives: 0 } } });
    expect(log.mock.calls[0][0]).not.toContain("s3cret");
    log.mockRestore();
  });

  it.each(["backfill-workspaceid", "Backfill-Workspace-Id", "backfill", "", null, 7, {}])("rejects the unrecognised action %j with 400 and runs nothing (a typo must never become POST-all)", async (action) => {
    const response = await post({ action });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: expect.stringContaining("Unknown action") });
    expect(mocks.applyMigrations).not.toHaveBeenCalled();
    expect(mocks.repair).not.toHaveBeenCalled();
  });

  it("rejects action together with script with 400 and runs nothing", async () => {
    for (const body of [{ action: "backfill-workspace-id", script: "069_workspace_id_residual_backfill" }, { action: "nonsense", script: "068_x" }]) {
      const response = await post(body);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: expect.stringContaining("not both") });
    }
    expect(mocks.applyMigrations).not.toHaveBeenCalled();
    expect(mocks.repair).not.toHaveBeenCalled();
  });

  it("does not open a database connection for a malformed request", async () => {
    await post({ action: "typo" });
    expect(mocks.end).not.toHaveBeenCalled();
  });

  it("a non-object body is treated as an ordinary untargeted POST, not as an action", async () => {
    await post([1, 2, 3]);
    expect(mocks.applyMigrations).toHaveBeenCalledWith(expect.anything(), "compass_preview", undefined);
    expect(mocks.repair).not.toHaveBeenCalled();
  });

  it("rejects a wrong secret of the same length in constant time (still 401)", async () => {
    expect((await post({ action: "backfill-workspace-id" }, "s3crez")).status).toBe(401);
  });

  it("ordinary script POSTs still go to the runner", async () => {
    await post({ script: "069_workspace_id_residual_backfill" });
    expect(mocks.applyMigrations).toHaveBeenCalledWith(expect.anything(), "compass_preview", "069_workspace_id_residual_backfill");
    expect(mocks.repair).not.toHaveBeenCalled();
  });
});
