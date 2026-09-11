/**
 * Confirms a previewlogin_-prefixed session, once inserted by
 * issuePreviewLoginSession, is resolved by the unmodified
 * createLazyPrismaAuthAdapter() exactly like any ordinary Auth.js database
 * session — it must never reach the preview-automation prefix branch
 * (`preview_`) or its previewAutomationSession/Run lookups. The mock Prisma
 * client below deliberately has no previewAutomationSession/Run models: if
 * the adapter mistakenly treated this token as an automation session, the
 * call would throw instead of silently passing.
 *
 * Mirrors __tests__/lib/lazy-prisma-auth-adapter.test.ts's harness pattern
 * for this adapter, and __tests__/lib/preview-login.test.ts's fixture for
 * issuePreviewLoginSession.
 */
import type { PrismaClient } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/preview-automation/scenarios", () => ({ applyPreviewScenario: vi.fn() }));
vi.mock("@/lib/schema", () => ({ getActiveSchema: vi.fn(() => "compass_preview") }));

import { createLazyPrismaAuthAdapter } from "@/lib/lazy-prisma-auth-adapter";
import { issuePreviewLoginSession } from "@/lib/preview-login";

function fixture() {
  let userCounter = 0;
  const sessions = new Map<string, { sessionToken: string; userId: string; expires: Date }>();
  const tx = {
    organization: { create: vi.fn().mockImplementation(({ data }) => ({ id: "org-1", ...data })) },
    user: {
      create: vi.fn().mockImplementation(({ data }) => {
        userCounter += 1;
        return { id: `user-${userCounter}`, ...data };
      }),
    },
    workspace: { create: vi.fn().mockImplementation(({ data }) => ({ id: "workspace-1", ...data })) },
    organizationMember: { createMany: vi.fn() },
    workspaceMember: { createMany: vi.fn() },
  };
  const client = {
    organization: { findUnique: vi.fn().mockResolvedValue(null) },
    workspace: { findFirst: vi.fn() },
    user: { findUnique: vi.fn() },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(tx)),
    session: {
      create: vi.fn().mockImplementation(({ data }) => {
        sessions.set(data.sessionToken, data);
        return data;
      }),
      findUnique: vi.fn().mockImplementation(({ where: { sessionToken } }: { where: { sessionToken: string } }) => {
        const row = sessions.get(sessionToken);
        if (!row) return null;
        return { ...row, user: { id: row.userId, email: "preview-owner@preview.invalid" } };
      }),
    },
  };
  return { client: client as unknown as PrismaClient };
}

describe("previewlogin_ session falls through to the ordinary Auth.js adapter", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does not match the preview_ automation prefix", async () => {
    const { client } = fixture();
    const issued = await issuePreviewLoginSession(client, "owner", new Date());
    expect(issued.sessionToken.startsWith("previewlogin_")).toBe(true);
    expect(issued.sessionToken.startsWith("preview_")).toBe(false);
  });

  it("is resolved as a plain database session with no automation-table lookups", async () => {
    const { client } = fixture();
    const issued = await issuePreviewLoginSession(client, "owner", new Date());

    // Constructing the adapter over a client that has no
    // previewAutomationSession/Run models: hitting that branch would throw.
    const adapter = createLazyPrismaAuthAdapter(() => client);
    const result = await adapter.getSessionAndUser!(issued.sessionToken);

    expect(result).not.toBeNull();
    expect(result!.session.sessionToken).toBe(issued.sessionToken);
    expect(result!.session.expires).toEqual(issued.expiresAt);
    expect(result!.user.email).toBe("preview-owner@preview.invalid");
  });
});
