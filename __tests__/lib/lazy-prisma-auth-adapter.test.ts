import { PrismaAdapter } from "@auth/prisma-adapter";
import type { PrismaClient } from "@prisma/client";
import type { AppPrismaClient } from "@/lib/db";
import { describe, expect, it, vi } from "vitest";

import { createLazyPrismaAuthAdapter } from "@/lib/lazy-prisma-auth-adapter";

describe("createLazyPrismaAuthAdapter", () => {
  it("does not initialize Prisma while constructing the adapter", () => {
    const getClient = vi.fn();

    createLazyPrismaAuthAdapter(getClient);

    expect(getClient).not.toHaveBeenCalled();
  });

  it("exposes every method provided by the concrete Prisma adapter", () => {
    const getClient = vi.fn();
    const concreteAdapter = PrismaAdapter({} as PrismaClient);

    const lazyAdapter = createLazyPrismaAuthAdapter(getClient);

    expect(Object.keys(lazyAdapter).sort()).toEqual(
      Object.keys(concreteAdapter).sort()
    );
    expect(lazyAdapter).toHaveProperty("createAuthenticator");
    expect(lazyAdapter).toHaveProperty("updateAuthenticatorCounter");
  });

  it("initializes Prisma once on first use and forwards arguments and results", async () => {
    const user = { id: "user-1", email: "rick@example.com" };
    const findUnique = vi.fn().mockResolvedValue(user);
    const getClient = vi.fn(() => ({
      user: { findUnique },
    }) as unknown as AppPrismaClient);
    const adapter = createLazyPrismaAuthAdapter(getClient);

    await expect(adapter.getUser?.("user-1")).resolves.toEqual(user);
    await expect(adapter.getUser?.("user-2")).resolves.toEqual(user);

    expect(getClient).toHaveBeenCalledTimes(1);
    expect(findUnique).toHaveBeenNthCalledWith(1, { where: { id: "user-1" } });
    expect(findUnique).toHaveBeenNthCalledWith(2, { where: { id: "user-2" } });
  });

  it("preserves missing-database errors until a DB-backed auth method is used", () => {
    const getClient = vi.fn(() => {
      throw new Error("Neither DATABASE_URL nor PGHOST is set.");
    });
    const adapter = createLazyPrismaAuthAdapter(getClient);

    expect(getClient).not.toHaveBeenCalled();
    expect(() => adapter.getUser?.("user-1")).toThrow(
      "Neither DATABASE_URL nor PGHOST is set."
    );
    expect(getClient).toHaveBeenCalledTimes(1);
  });

  it("delegates ordinary sessions without requiring preview tables to exist", async () => {
    const row = { sessionToken: "ordinary-token", user: { id: "ordinary-user" }, expires: new Date(Date.now() + 60000) };
    const client = { session: { findUnique: vi.fn().mockResolvedValue(row), update: vi.fn().mockResolvedValue(row) } };
    const adapter = createLazyPrismaAuthAdapter(() => client as unknown as AppPrismaClient);
    expect(await adapter.getSessionAndUser!("ordinary-token")).toEqual({ user: row.user, session: { sessionToken: row.sessionToken, expires: row.expires } });
    await adapter.updateSession!({ sessionToken: "ordinary-token", expires: row.expires });
    expect(client.session.findUnique).toHaveBeenCalledTimes(1);
  });

  it("denies automation sessions when the run has expired or disappeared", async () => {
    const session = { sessionToken: "preview_test", previewAutomationRunId: "run", user: { id: "owner" } };
    const client = { session: { findUnique: vi.fn().mockResolvedValue(session) }, previewAutomationRun: { findUnique: vi.fn().mockResolvedValue(null) } };
    const adapter = createLazyPrismaAuthAdapter(() => client as unknown as AppPrismaClient);
    expect(await adapter.getSessionAndUser!("preview_test")).toBeNull();
  });

  it("does not reinterpret an automation cookie with missing run identity as a normal session", async () => {
    const client = { session: { findUnique: vi.fn().mockResolvedValue({ sessionToken: "preview_test", previewAutomationRunId: null, user: { id: "owner" } }) } };
    const adapter = createLazyPrismaAuthAdapter(() => client as unknown as AppPrismaClient);
    expect(await adapter.getSessionAndUser!("preview_test")).toBeNull();
  });

  it("caps Auth.js refresh to the absolute automation deadline", async () => {
    vi.stubEnv("PREVIEW_AUTOMATION_ENABLED", "1");
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "deployment");
    try {
      const expiresAt = new Date(Date.now() + 60_000);
      const row = { sessionToken: "preview_test", previewAutomationRunId: "run", userId: "owner", expires: expiresAt };
      const client = { previewAutomationSession: { findUnique: vi.fn().mockResolvedValue({ runId: "run" }) }, session: { findUnique: vi.fn().mockResolvedValue(row), update: vi.fn().mockResolvedValue(row) }, previewAutomationRun: { findUnique: vi.fn().mockResolvedValue({ id: "run", deploymentId: "deployment", expiresAt, revokedAt: null, ownerUserId: "owner", viewerUserId: "viewer" }) } };
      const adapter = createLazyPrismaAuthAdapter(() => client as unknown as AppPrismaClient);
      await adapter.updateSession!({ sessionToken: "preview_test", expires: new Date(Date.now() + 30 * 86400_000) });
      expect(client.session.update).toHaveBeenCalledWith({ where: { sessionToken: "preview_test" }, data: { sessionToken: "preview_test", expires: expiresAt } });
    } finally { vi.unstubAllEnvs(); }
  });
});
