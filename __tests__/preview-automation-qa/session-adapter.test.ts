import type { PrismaClient } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLazyPrismaAuthAdapter } from "@/lib/lazy-prisma-auth-adapter";

const now = new Date("2026-09-06T12:00:00Z");
const deadline = new Date(now.getTime() + 3_600_000);
const run = { id: "run", deploymentId: "dpl_test", expiresAt: deadline, revokedAt: null, ownerUserId: "owner", viewerUserId: "member" };
function client() {
  const row = { sessionToken: "preview_test", userId: "owner", expires: new Date(now.getTime() + 30 * 86_400_000), user: { id: "owner", email: "owner@preview.invalid" } };
  const db = {
    session: { findUnique: vi.fn().mockResolvedValue(row), update: vi.fn().mockResolvedValue(row) },
    previewAutomationSession: { findUnique: vi.fn().mockResolvedValue({ sessionToken: row.sessionToken, runId: "run" }) },
    previewAutomationRun: { findUnique: vi.fn().mockResolvedValue(run) },
  };
  return { db, row, adapter: createLazyPrismaAuthAdapter(() => db as unknown as PrismaClient) };
}
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(now);
  vi.stubEnv("PREVIEW_AUTOMATION_ENABLED", "1"); vi.stubEnv("VERCEL_ENV", "preview"); vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_test");
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("independent QA: automation sessions remain distinguishable after partial deletion", () => {
  it("denies a prefixed cookie when its mapping is missing", async () => {
    const { db, adapter } = client();
    db.previewAutomationSession.findUnique.mockResolvedValue(null as never);
    expect(await adapter.getSessionAndUser!("preview_test")).toBeNull();
    expect(await adapter.updateSession!({ sessionToken: "preview_test", expires: deadline })).toBeNull();
    expect(db.session.update).not.toHaveBeenCalled();
  });
  it.each([
    null, { ...run, revokedAt: now }, { ...run, expiresAt: now },
    { ...run, deploymentId: "dpl_other" }, { ...run, ownerUserId: "different-owner" },
  ])("denies retrieval and refresh for invalid run %j", async registry => {
    const { db, adapter } = client();
    db.previewAutomationRun.findUnique.mockResolvedValue(registry as never);
    expect(await adapter.getSessionAndUser!("preview_test")).toBeNull();
    expect(await adapter.updateSession!({ sessionToken: "preview_test", expires: deadline })).toBeNull();
    expect(db.session.update).not.toHaveBeenCalled();
  });
  it("clips an already overextended stored session before returning it to Auth.js", async () => {
    const { adapter } = client();
    expect((await adapter.getSessionAndUser!("preview_test"))?.session.expires).toEqual(deadline);
  });
  it("does not extend a deliberately shorter session during a refresh", async () => {
    const { db, adapter } = client();
    const shorter = new Date(now.getTime() + 60_000);
    await adapter.updateSession!({ sessionToken: "preview_test", expires: shorter });
    expect(db.session.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ expires: shorter }) }));
  });
  it("rejects a previously valid cookie exactly at the absolute deadline", async () => {
    const { adapter } = client();
    expect(await adapter.getSessionAndUser!("preview_test")).not.toBeNull();
    vi.setSystemTime(deadline);
    expect(await adapter.getSessionAndUser!("preview_test")).toBeNull();
  });
  it.each(["production", "development"])("does not look up automation mapping tables in %s", async environment => {
    vi.stubEnv("VERCEL_ENV", environment);
    const { db, adapter } = client();
    expect(await adapter.getSessionAndUser!("preview_test")).toBeNull();
    expect(db.previewAutomationSession.findUnique).not.toHaveBeenCalled();
    expect(db.previewAutomationRun.findUnique).not.toHaveBeenCalled();
  });
  it("ordinary login and refresh do not depend on automation tables or new Session fields", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    const user = { id: "ordinary-user", email: "ordinary@example.com" };
    const session = { sessionToken: "ordinary-token", userId: user.id, expires: deadline, user };
    // Intentionally no automation tables: simulates an existing deployment
    // before the opt-in preview migrations have ever run.
    const db = { session: { findUnique: vi.fn().mockResolvedValue(session), update: vi.fn().mockResolvedValue(session) } };
    const adapter = createLazyPrismaAuthAdapter(() => db as unknown as PrismaClient);
    expect((await adapter.getSessionAndUser!("ordinary-token"))?.user).toEqual(user);
    await adapter.updateSession!({ sessionToken: "ordinary-token", expires: deadline });
    expect(db.session.findUnique).toHaveBeenCalledWith({ where: { sessionToken: "ordinary-token" }, include: { user: true } });
    expect(db.session.update).toHaveBeenCalledWith({ where: { sessionToken: "ordinary-token" }, data: { sessionToken: "ordinary-token", expires: deadline } });
  });
});
