/**
 * Real-PostgreSQL integration check for lib/preview-login.ts's
 * ensureSampleWorkspace/issuePreviewLoginSession, gated the same way as
 * __tests__/preview-automation-qa/postgres-integration.test.ts: explicit
 * opt-in via PREVIEW_QA_DATABASE_URL, a disposable schema in the guarded
 * local compass_e2e database, never compass_dev/public/a real schema.
 *
 * Exercises the actual seed path (lib/preview-automation/scenarios.ts's
 * "full-data" scenario, unmocked) against real SQL, and confirms the issued
 * previewlogin_ session is resolvable by the real, unmodified
 * createLazyPrismaAuthAdapter().
 */
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { Pool } from "pg";
import { PrismaClient } from "@prisma/client";
import type { AppPrismaClient } from "@/lib/db";
import { injectUpdatedAtExtension } from "@/lib/prisma-updated-at";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const databaseUrl = process.env.PREVIEW_QA_DATABASE_URL;

describe.skipIf(!databaseUrl)("preview-login sample workspace (not DSQL isolation evidence)", () => {
  let pool: Pool;
  let prisma: AppPrismaClient;
  const schema = `compass_previewlogin_qa_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  let ensureSampleWorkspace: typeof import("@/lib/preview-login").ensureSampleWorkspace;
  let issuePreviewLoginSession: typeof import("@/lib/preview-login").issuePreviewLoginSession;

  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (url.protocol !== "postgresql:" || !["127.0.0.1", "localhost"].includes(url.hostname) || url.pathname !== "/compass_e2e" || url.searchParams.has("schema")) {
      throw new Error("PREVIEW_QA_DATABASE_URL must be a local compass_e2e database without a schema override");
    }
    pool = new Pool({ connectionString: url.toString(), max: 5 });
    const existing = await pool.query("SELECT schema_name FROM information_schema.schemata WHERE schema_name=$1", [schema]);
    if (existing.rows.length) throw new Error("Refusing to adopt existing QA schema");
    await pool.query(`CREATE SCHEMA "${schema}"`);
    url.searchParams.set("schema", schema);
    execFileSync("pnpm", ["exec", "prisma", "db", "push", "--url", url.toString()], { encoding: "utf8", stdio: "pipe", timeout: 60_000 });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool, { schema }) }).$extends(injectUpdatedAtExtension);

    // lib/preview-login.ts derives the schema for applyPreviewScenario's raw
    // SQL from getActiveSchema(); point it at this disposable schema instead
    // of deriving from VERCEL_ENV, matching the schema the client above is
    // actually bound to.
    vi.doMock("@/lib/schema", () => ({ getActiveSchema: () => schema }));
    const mod = await import("@/lib/preview-login");
    ensureSampleWorkspace = mod.ensureSampleWorkspace;
    issuePreviewLoginSession = mod.issuePreviewLoginSession;
    console.info(`QA-only PostgreSQL schema: ${schema}`);
  }, 90_000);

  afterAll(async () => {
    vi.doUnmock("@/lib/schema");
    if (prisma) await prisma.$disconnect();
    if (pool) await pool.end();
  });

  it("creates the sample org/workspace/users and seeds full demo data exactly once", async () => {
    const first = await ensureSampleWorkspace(prisma);
    expect(first.orgSlug).toBe("preview-sample");
    expect(first.workspaceSlug).toBe("workspace");
    expect(await prisma.organization.count({ where: { slug: "preview-sample" } })).toBe(1);
    expect(await prisma.user.count({ where: { email: { in: ["preview-owner@preview.invalid", "preview-viewer@preview.invalid"] } } })).toBe(2);

    const workspace = await prisma.workspace.findFirstOrThrow({ where: { slug: "workspace" } });
    const opportunityCount = await prisma.opportunity.count({ where: { workspaceId: workspace.id } });
    expect(opportunityCount).toBeGreaterThan(0);

    const second = await ensureSampleWorkspace(prisma);
    expect(second).toEqual(first);
    expect(await prisma.organization.count({ where: { slug: "preview-sample" } })).toBe(1);
    expect(await prisma.user.count({ where: { email: { in: ["preview-owner@preview.invalid", "preview-viewer@preview.invalid"] } } })).toBe(2);
    expect(await prisma.opportunity.count({ where: { workspaceId: workspace.id } })).toBe(opportunityCount);
  }, 30_000);

  it("issues a real session the unmodified auth adapter resolves as an ordinary session", async () => {
    const session = await issuePreviewLoginSession(prisma, "viewer");
    expect(session.sessionToken.startsWith("previewlogin_")).toBe(true);
    expect(session.sessionToken.startsWith("preview_")).toBe(false);

    const { createLazyPrismaAuthAdapter } = await import("@/lib/lazy-prisma-auth-adapter");
    const adapter = createLazyPrismaAuthAdapter(() => prisma);
    const resolved = await adapter.getSessionAndUser!(session.sessionToken);
    expect(resolved).not.toBeNull();
    expect(resolved!.session.expires.getTime()).toBe(session.expiresAt.getTime());
    expect(resolved!.user.email).toBe("preview-viewer@preview.invalid");
  }, 30_000);
});
