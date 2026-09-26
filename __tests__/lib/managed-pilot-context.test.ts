import { afterEach, describe, expect, it, vi } from "vitest";
import { getActiveSchema } from "@/lib/schema";
import { getDatabaseUser } from "@/lib/db";

export const managedEnvironment = {
  PREVIEW_DATABASE_MODE: "vercel-managed", PREVIEW_AUTOMATION_ENABLED: "1",
  VERCEL_ENV: "preview", VERCEL_GIT_PULL_REQUEST_ID: "276",
  VERCEL_GIT_COMMIT_SHA: "a".repeat(40), VERCEL_DEPLOYMENT_ID: "dpl_test",
  VERCEL_GIT_REPO_OWNER: "rbcodelabs", VERCEL_GIT_REPO_SLUG: "compass",
  VERCEL_GIT_COMMIT_REF: "feat/geode-docs-preview-pilot",
  VERCEL_URL: "compass-test.vercel.app",
  PREVIEW_MANAGED_RUN_ID: "11111111-1111-4111-8111-111111111111",
  PREVIEW_MANAGED_WORKSPACE_ID: "22222222-2222-4222-8222-222222222222",
  PGSCHEMA: "", DATABASE_URL: "", PGUSER: "admin",
};
describe("explicit managed preview boundary", () => {
  afterEach(() => vi.unstubAllEnvs());
  function configure(overrides: Record<string, string | undefined> = {}) {
    for (const [key, value] of Object.entries({ ...managedEnvironment, ...overrides })) vi.stubEnv(key, value);
  }
  it("uses the managed database identity only for the approved preview", () => {
    configure();
    expect(getDatabaseUser()).toBe("admin");
    expect(getActiveSchema()).toBe("compass_pr_276_aaaaaaaaaaaa");
  });
  it.each([
    { VERCEL_ENV: "production" }, { PREVIEW_AUTOMATION_ENABLED: "0" },
    { VERCEL_GIT_PULL_REQUEST_ID: "277" }, { VERCEL_GIT_REPO_OWNER: "fork" },
    { VERCEL_GIT_REPO_SLUG: "other" }, { VERCEL_GIT_COMMIT_REF: "main" },
    { VERCEL_DEPLOYMENT_ID: "" }, { VERCEL_URL: "evil.example" },
    { PREVIEW_MANAGED_RUN_ID: "" }, { PREVIEW_MANAGED_WORKSPACE_ID: "" },
    { PGSCHEMA: "compass_prod" }, { DATABASE_URL: "postgres://admin@host/db" },
    { PREVIEW_DATABASE_MODE: "typo" },
  ])("rejects conflicting metadata before selecting a schema: %j", (overrides) => {
    configure(overrides);
    expect(() => getActiveSchema()).toThrow();
  });
});
