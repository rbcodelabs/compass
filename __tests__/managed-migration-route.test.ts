import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({ init: vi.fn(), apply: vi.fn(), status: vi.fn(), end: vi.fn(), pool: vi.fn() }));
vi.mock("@/lib/preview-automation/managed-database", () => ({ createManagedMigrationPool: mocks.pool }));
vi.mock("@/lib/preview-automation/managed-migrations", () => ({
  initializeManagedPilot: mocks.init, applyManagedMigration: mocks.apply, getManagedMigrationStatus: mocks.status,
}));
import { GET, POST } from "@/app/api/admin/migrate/route";
const sha = "a".repeat(40);
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("PREVIEW_DATABASE_MODE", "vercel-managed");
  vi.stubEnv("VERCEL_ENV", "preview"); vi.stubEnv("PREVIEW_AUTOMATION_ENABLED", "1");
  vi.stubEnv("VERCEL_GIT_PULL_REQUEST_ID", "276"); vi.stubEnv("VERCEL_GIT_COMMIT_SHA", sha);
  vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_Test"); vi.stubEnv("VERCEL_URL", "compass-test.vercel.app");
  vi.stubEnv("VERCEL_GIT_REPO_OWNER", "rbcodelabs"); vi.stubEnv("VERCEL_GIT_REPO_SLUG", "compass");
  vi.stubEnv("VERCEL_GIT_COMMIT_REF", "feat/geode-docs-preview-pilot");
  vi.stubEnv("PREVIEW_MANAGED_RUN_ID", "11111111-1111-4111-8111-111111111111");
  vi.stubEnv("PREVIEW_MANAGED_WORKSPACE_ID", "22222222-2222-4222-8222-222222222222");
  vi.stubEnv("DATABASE_URL", ""); vi.stubEnv("PGSCHEMA", ""); vi.stubEnv("MIGRATION_SECRET", "test-secret");
  mocks.pool.mockReturnValue({ end: mocks.end });
  mocks.init.mockResolvedValue(Response.json({ initialized: true }));
  mocks.status.mockResolvedValue(Response.json({ ready: false }));
  mocks.apply.mockResolvedValue(Response.json({ applied: true }));
});
function request(body?: unknown, deployment = "dpl_Test") {
  return new NextRequest("https://compass-test.vercel.app/api/admin/migrate", {
    method: body ? "POST" : "GET", headers: { "x-migration-secret": "test-secret", "x-preview-deployment-id": deployment },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
describe("managed migration endpoint", () => {
  it("allows authenticated initialization bound to deployment", async () => {
    expect((await POST(request({ action: "initialize" }))).status).toBe(200);
    expect(mocks.init).toHaveBeenCalledOnce();
  });
  it("allows read-only managed status", async () => {
    expect((await GET(request())).status).toBe(200);
    expect(mocks.status).toHaveBeenCalledOnce();
  });
  it.each([{}, { script: "059_geode_document_storage", schema: "public" }, { sql: "DROP TABLE docs" }])("rejects unsafe body %j before pool", async body => {
    expect((await POST(request(body))).status).toBe(400); expect(mocks.pool).not.toHaveBeenCalled();
  });
  it("rejects wrong deployment before pool", async () => {
    expect((await POST(request({ action: "initialize" }, "dpl_Other"))).status).toBe(403);
    expect(mocks.pool).not.toHaveBeenCalled();
  });
  it("rejects production configuration before pool", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    expect((await POST(request({ action: "initialize" }))).status).toBe(403);
    expect(mocks.pool).not.toHaveBeenCalled();
  });
});
