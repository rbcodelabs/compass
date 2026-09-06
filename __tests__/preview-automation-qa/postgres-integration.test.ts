import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { Pool } from "pg";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { bootstrapPreviewRun, cleanupPreviewRun, issuePreviewSession, teardownPreviewRun } from "@/lib/preview-automation/service";
import { createLazyPrismaAuthAdapter } from "@/lib/lazy-prisma-auth-adapter";
import type { PreviewGrant } from "@/lib/preview-automation/grants";

// Explicit opt-in only. Never reuse compass_dev, public, an existing schema,
// or a non-local/non-disposable database. Retain schema for failure inspection.
const databaseUrl = process.env.PREVIEW_QA_DATABASE_URL;
describe.skipIf(!databaseUrl)("real PostgreSQL preview lifecycle (not DSQL isolation evidence)", () => {
  let pool: Pool;
  let prisma: PrismaClient;
  const schema = `compass_pr_999999_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const runA = randomUUID(), runB = randomUUID();
  const deploymentId = "dpl_qaIntegration";
  function grant(runId: string, operation: PreviewGrant["operation"] = "bootstrap", persona?: PreviewGrant["persona"]): PreviewGrant {
    const now = Math.floor(Date.now() / 1000);
    return { v: 1, iss: "compass-preview-controller", aud: "compass-preview-automation", deploymentId,
      origin: "https://qa-integration.vercel.app", runId, operation, nonce: randomUUID(), iat: now, exp: now + 300,
      ...(persona ? { persona } : {}),
    };
  }
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
    prisma = new PrismaClient({ adapter: new PrismaPg(pool, { schema }) });
    vi.stubEnv("VERCEL_ENV", "preview"); vi.stubEnv("PREVIEW_AUTOMATION_ENABLED", "1"); vi.stubEnv("VERCEL_DEPLOYMENT_ID", deploymentId);
    console.info(`QA-only PostgreSQL schema: ${schema}`);
  }, 90_000);
  afterAll(async () => {
    vi.unstubAllEnvs();
    if (prisma) await prisma.$disconnect();
    if (pool) await pool.end();
  });

  it("permits one concurrent bootstrap winner for one nonce without duplicating tenants", async () => {
    const operation = grant(runA);
    const outcomes = await Promise.allSettled([bootstrapPreviewRun(prisma, operation), bootstrapPreviewRun(prisma, operation)]);
    expect(outcomes.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(result => result.status === "rejected")).toHaveLength(1);
    expect(await prisma.previewAutomationRun.count({ where: { id: runA } })).toBe(1);
    expect(await prisma.previewAutomationNonce.count({ where: { nonce: operation.nonce } })).toBe(1);
    expect(await prisma.organization.count({ where: { slug: `preview-${runA}` } })).toBe(1);
    const retry = await bootstrapPreviewRun(prisma, grant(runA));
    expect(retry.runId).toBe(runA);
    expect(await prisma.organization.count({ where: { slug: `preview-${runA}` } })).toBe(1);
  });

  it("isolates separate runs and refuses concurrent session-grant replay", async () => {
    await bootstrapPreviewRun(prisma, grant(runB));
    const a = await prisma.previewAutomationRun.findUniqueOrThrow({ where: { id: runA } });
    const b = await prisma.previewAutomationRun.findUniqueOrThrow({ where: { id: runB } });
    expect(a.workspaceId).not.toBe(b.workspaceId);
    expect(a.ownerUserId).not.toBe(b.ownerUserId);
    const operation = grant(runA, "session", "owner");
    const results = await Promise.allSettled([issuePreviewSession(prisma, operation), issuePreviewSession(prisma, operation)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(await prisma.previewAutomationSession.count({ where: { runId: runA } })).toBe(1);
  });

  it("rolls back nonce, registry and partial fixtures when synthetic identity insertion fails", async () => {
    const blockedRun = randomUUID();
    const existing = await prisma.user.create({ data: { email: `owner-${blockedRun}@preview.invalid`, name: "Collision fixture" } });
    const operation = grant(blockedRun);
    await expect(bootstrapPreviewRun(prisma, operation)).rejects.toThrow();
    expect(await prisma.previewAutomationRun.count({ where: { id: blockedRun } })).toBe(0);
    expect(await prisma.previewAutomationNonce.count({ where: { nonce: operation.nonce } })).toBe(0);
    expect(await prisma.user.findUnique({ where: { id: existing.id } })).not.toBeNull();
    await prisma.user.delete({ where: { id: existing.id } });
  });

  it("cleans a mixed product graph while preserving another run and its session", async () => {
    const a = await prisma.previewAutomationRun.findUniqueOrThrow({ where: { id: runA } });
    const b = await prisma.previewAutomationRun.findUniqueOrThrow({ where: { id: runB } });
    const opportunity = await prisma.opportunity.create({ data: { workspaceId: a.workspaceId, title: "Disposable opportunity" } });
    const solution = await prisma.solution.create({ data: { opportunityId: opportunity.id, title: "Disposable solution" } });
    const task = await prisma.task.create({ data: { workspaceId: a.workspaceId, title: "Disposable task" } });
    await prisma.taskLink.create({ data: { taskId: task.id, linkedType: "SOLUTION", linkedId: solution.id } });
    const doc = await prisma.doc.create({ data: { workspaceId: a.workspaceId, title: "Disposable document" } });
    await prisma.comment.create({ data: { workspaceId: a.workspaceId, targetType: "DOC", targetId: doc.id, body: "Disposable comment", authorName: "Preview Owner" } });
    const preserved = await prisma.opportunity.create({ data: { workspaceId: b.workspaceId, title: "Must survive cleanup" } });
    const sessionB = await issuePreviewSession(prisma, grant(runB, "session", "viewer"));
    await expect(cleanupPreviewRun(prisma, runA, deploymentId)).resolves.toMatchObject({ cleaned: true });
    expect(await prisma.workspace.findUnique({ where: { id: a.workspaceId } })).toBeNull();
    expect(await prisma.task.findUnique({ where: { id: task.id } })).toBeNull();
    expect(await prisma.taskLink.count({ where: { taskId: task.id } })).toBe(0);
    expect(await prisma.solution.findUnique({ where: { id: solution.id } })).toBeNull();
    expect(await prisma.comment.count({ where: { workspaceId: a.workspaceId } })).toBe(0);
    expect(await prisma.previewAutomationSession.count({ where: { runId: runA } })).toBe(0);
    expect(await prisma.opportunity.findUnique({ where: { id: preserved.id } })).not.toBeNull();
    expect(await prisma.session.findUnique({ where: { sessionToken: sessionB.sessionToken } })).not.toBeNull();
    expect((await prisma.previewAutomationRun.findUniqueOrThrow({ where: { id: runA } })).revokedAt).not.toBeNull();
    await expect(cleanupPreviewRun(prisma, runA, deploymentId)).resolves.toMatchObject({ cleaned: true });
  }, 30_000);

  it("caps real session refresh at the run deadline and denies expired sessions", async () => {
    const session = await issuePreviewSession(prisma, grant(runB, "session", "owner"));
    const adapter = createLazyPrismaAuthAdapter(() => prisma);
    await adapter.updateSession!({ sessionToken: session.sessionToken, expires: new Date(Date.now() + 30 * 86_400_000) });
    expect((await prisma.session.findUniqueOrThrow({ where: { sessionToken: session.sessionToken } })).expires).toEqual(session.expiresAt);
    await prisma.previewAutomationRun.update({ where: { id: runB }, data: { expiresAt: new Date(Date.now() - 1) } });
    expect(await adapter.getSessionAndUser!(session.sessionToken)).toBeNull();
    await expect(cleanupPreviewRun(prisma, runB, deploymentId)).resolves.toMatchObject({ cleaned: true });
  }, 30_000);

  it("serializes session issuance against teardown rather than leaving a post-cleanup session", async () => {
    const raceRun = randomUUID();
    await bootstrapPreviewRun(prisma, grant(raceRun));
    const row = await prisma.previewAutomationRun.findUniqueOrThrow({ where: { id: raceRun } });
    let reachedCreate!: () => void;
    let releaseCreate!: () => void;
    const reached = new Promise<void>(resolve => { reachedCreate = resolve; });
    const release = new Promise<void>(resolve => { releaseCreate = resolve; });
    // Keep all real SQL and transactions. Delay only the final INSERT so
    // teardown is forced to overlap the interval after the active-run read.
    const delayed = new Proxy(prisma, {
      get(target, property, receiver) {
        if (property !== "$transaction") return Reflect.get(target, property, receiver);
        return (callback: (tx: unknown) => unknown) => target.$transaction(async tx => callback(new Proxy(tx, {
          get(transaction, model, modelReceiver) {
            if (model !== "session") return Reflect.get(transaction, model, modelReceiver);
            return new Proxy(transaction.session, {
              get(delegate, method, delegateReceiver) {
                if (method !== "create") return Reflect.get(delegate, method, delegateReceiver);
                return async (args: Parameters<typeof delegate.create>[0]) => {
                  reachedCreate();
                  await release;
                  return delegate.create(args);
                };
              },
            });
          },
        })));
      },
    });
    const issuing = issuePreviewSession(delayed, grant(raceRun, "session", "owner"));
    await reached;
    const cleaning = cleanupPreviewRun(prisma, raceRun, deploymentId);
    // An unfenced implementation can delete sessions before the paused INSERT.
    // A correctly fenced run row holds cleanup until issuance commits.
    setTimeout(releaseCreate, 200);
    const results = await Promise.allSettled([issuing, cleaning]);
    expect(results[1].status).toBe("fulfilled");
    expect(await prisma.session.count({ where: { userId: { in: [row.ownerUserId, row.viewerUserId] } } })).toBe(0);
    expect(await prisma.previewAutomationSession.count({ where: { runId: raceRun } })).toBe(0);
  }, 30_000);

  it("an early teardown prevents a delayed bootstrap from resurrecting a canceled run", async () => {
    const canceledRun = randomUUID();
    await teardownPreviewRun(prisma, grant(canceledRun, "teardown"));
    await expect(bootstrapPreviewRun(prisma, grant(canceledRun))).rejects.toThrow();
    expect(await prisma.organization.count({ where: { slug: `preview-${canceledRun}` } })).toBe(0);
    expect((await prisma.previewAutomationRun.findUniqueOrThrow({ where: { id: canceledRun } })).revokedAt).not.toBeNull();
  });
});
