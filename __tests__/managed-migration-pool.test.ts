import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
const captured = vi.hoisted(() => ({ options: undefined as undefined | Record<string, unknown> }));
vi.mock("pg", () => ({ Pool: class { constructor(options: Record<string, unknown>) { captured.options = options; } } }));
vi.mock("@aws-sdk/dsql-signer", () => ({ DsqlSigner: class { getDbConnectAdminAuthToken() { return "token"; } } }));
vi.mock("@vercel/functions/oidc", () => ({ awsCredentialsProvider: () => ({}) }));
vi.mock("@/lib/preview-automation/managed-context", () => ({ getManagedPilotContext: () => ({ schema: "compass_pr_276_aaaaaaaaaaaa" }) }));
vi.mock("@/lib/preview-automation/managed-migrations", () => ({ assertManagedPilotReady: vi.fn() }));
import { createManagedMigrationPool } from "@/lib/preview-automation/managed-database";

describe("managed migration pool", () => {
  it("lets one DSQL async-index wait outlast 40s but stay inside the route budget", () => {
    vi.stubEnv("PGHOST", "cluster.dsql.test"); vi.stubEnv("AWS_ROLE_ARN", "arn:aws:iam::1:role/test");
    createManagedMigrationPool();
    const maxDuration = Number(/export const maxDuration = (\d+);/.exec(readFileSync("app/api/admin/migrate/route.ts", "utf8"))?.[1]);
    const timeout = captured.options?.query_timeout as number;
    // CALL sys.wait_for_job for one 047 index exceeded the old 40s read timeout.
    expect(timeout).toBeGreaterThan(120_000);
    expect(timeout).toBeLessThan(maxDuration * 1000);
  });
});
