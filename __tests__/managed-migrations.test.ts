import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { initializeManagedPilot, getManagedMigrationStatus, applyManagedMigration } from "@/lib/preview-automation/managed-migrations";
const m = vi.hoisted(() => ({ query: vi.fn(), release: vi.fn(), status: vi.fn(), apply: vi.fn() }));
vi.mock("@/lib/migrations/runner", () => ({
  assertManagedMigrationManifest: () => {},
  getMigrationStatus: m.status, applyMigrations: m.apply,
  partitionPendingMigrations: (_schema: string, applied: Set<string>) => ({ pending: ["001_init", "002_custom_fields"].filter(name => !applied.has(name)).map(name => ({ name, filePath: `prisma/migrations/${name}/migration.sql` })), notApplicable: [] }),
}));
const context = { schema: "compass_pr_276_aaaaaaaaaaaa", pr: "276", sha: "a".repeat(40), deploymentId: "dpl_Test", origin: "https://test.vercel.app", runId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
const pool = { connect: async () => ({ query: m.query, release: m.release }) } as unknown as Pool;
const owner = { deployment_id: context.deploymentId, commit_sha: context.sha, run_id: context.runId, workspace_id: context.workspaceId, claimed_by: null, claim_script: null };
beforeEach(() => {
  vi.resetAllMocks();
  m.query.mockResolvedValue({ rows: [], rowCount: 0 });
  m.status.mockResolvedValue(Response.json({ pending: [], unresolvedMigrations: [], appliedMigrations: ["059_geode_document_storage"], geodeDocumentStorage: { ready: true } }));
  m.apply.mockResolvedValue(Response.json({ applied: true }));
});
describe("managed migration ownership", () => {
  it("creates ownership only after winning a new schema creation", async () => {
    const result = await initializeManagedPilot(pool, context);
    expect(result.status).toBe(200);
    expect(m.query.mock.calls.some(([sql]) => /CREATE SCHEMA/.test(sql) && !/IF NOT EXISTS/.test(sql))).toBe(true);
    expect(m.query.mock.calls.some(([sql]) => /INSERT INTO[\s\S]*_managed_pilot_owner/.test(sql))).toBe(true);
  });
  it("never adopts existing schema without owner", async () => {
    m.query.mockResolvedValueOnce({ rows: [{ schema_name: context.schema }] }).mockRejectedValueOnce(new Error("missing owner"));
    await expect(initializeManagedPilot(pool, context)).rejects.toThrow();
    expect(m.query.mock.calls.some(([sql]) => /CREATE|INSERT|UPDATE/.test(sql))).toBe(false);
  });
  it("rejects mismatched owner", async () => {
    m.query.mockResolvedValue({ rows: [{ ...owner, deployment_id: "dpl_Other" }] });
    await expect(getManagedMigrationStatus(pool, context)).rejects.toThrow(/owner/i);
  });
  it("rejects unknown scripts without runner mutations", async () => {
    await expect(applyManagedMigration(pool, context, "arbitrary_sql")).rejects.toThrow(/registered/i);
    expect(m.apply).not.toHaveBeenCalled();
  });
  it("never steals an existing claim", async () => {
    m.query.mockResolvedValueOnce({ rows: [owner] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await expect(applyManagedMigration(pool, context, "001_init")).rejects.toThrow(/claim/i);
    expect(m.apply).not.toHaveBeenCalled();
  });
  it("retains claim if runner throws", async () => {
    m.query.mockResolvedValueOnce({ rows: [owner] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ claimed_by: "id" }], rowCount: 1 });
    m.apply.mockRejectedValueOnce(new Error("timeout"));
    await expect(applyManagedMigration(pool, context, "001_init")).rejects.toThrow("timeout");
    expect(m.query.mock.calls.some(([sql]) => /SET claimed_by=NULL/.test(sql))).toBe(false);
  });
  it("rejects skipping baseline migration order", async () => {
    m.query.mockResolvedValueOnce({ rows: [owner] }).mockResolvedValueOnce({ rows: [] });
    await expect(applyManagedMigration(pool, context, "002_custom_fields")).rejects.toThrow(/first pending/);
    expect(m.apply).not.toHaveBeenCalled();
  });
  it("refuses readiness when a baseline expected index is missing", async () => {
    m.status.mockResolvedValueOnce(Response.json({ pending: [], unresolvedMigrations: [], appliedMigrations: ["001_init", "059_geode_document_storage"], geodeDocumentStorage: { ready: true } }));
    m.query.mockResolvedValueOnce({ rows: [owner] }).mockResolvedValueOnce({ rows: [] });
    const status = await (await getManagedMigrationStatus(pool, context)).json();
    expect(status.managed.ready).toBe(false);
    expect(status.managed.missingOrInvalidIndexes).toContain("users_email_key");
  });
  it("refuses readiness on an uncertain claim even with empty pending", async () => {
    m.query.mockResolvedValueOnce({ rows: [{ ...owner, claimed_by: "claim" }] }).mockResolvedValueOnce({ rows: [] });
    expect((await (await getManagedMigrationStatus(pool, context)).json()).managed.ready).toBe(false);
  });
});
