/**
 * Unit tests for app/api/admin/normalize-member-roles/route.ts.
 *
 * One-time-ops admin endpoint gated by MIGRATION_SECRET, same trust boundary as
 * the migrate and purge-feedback routes. It exists because the CLI script
 * cannot reach preview or production: Aurora DSQL auth needs a Vercel OIDC
 * token that only exists inside the Vercel runtime.
 *
 * Safety invariant under test: dryRun DEFAULTS TO TRUE. This is inverted from
 * the CLI, where the default is to write. An unparameterized POST, an empty
 * body, or unparseable JSON must all report rather than mutate -- only an
 * explicit {"dryRun": false} writes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const mockNormalizeMemberRoles = vi.fn();
const mockPrisma = { marker: "prisma" };

vi.mock("@/lib/db", () => ({
  default: () => mockPrisma,
}));

vi.mock("@/lib/normalize-member-roles", () => ({
  normalizeMemberRoles: (...args: unknown[]) => mockNormalizeMemberRoles(...args),
}));

import { POST } from "@/app/api/admin/normalize-member-roles/route";

const ORIGINAL_ENV = { ...process.env };

const REPORT = {
  dryRun: true,
  workspaceMembers: { scanned: 1, changed: 1, skipped: 0, changes: [] },
  organizationMembers: { scanned: 0, changed: 0, skipped: 0, changes: [] },
  organizationOwners: { scanned: 0, promoted: 0, alreadyOwned: 0, emptySkipped: 0, entries: [] },
  totalChanged: 1,
  totalSkipped: 0,
};

function request(body?: unknown, secret = "test-migration-secret") {
  return new NextRequest("http://localhost/api/admin/normalize-member-roles", {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: {
      "Content-Type": "application/json",
      "x-migration-secret": secret,
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.MIGRATION_SECRET = "test-migration-secret";
  mockNormalizeMemberRoles.mockResolvedValue(REPORT);
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("POST /api/admin/normalize-member-roles", () => {
  it("rejects a request without the correct x-migration-secret header", async () => {
    const res = await POST(request({ dryRun: false }, "wrong-secret"));

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(mockNormalizeMemberRoles).not.toHaveBeenCalled();
  });

  it("rejects when MIGRATION_SECRET is not configured at all", async () => {
    delete process.env.MIGRATION_SECRET;

    const res = await POST(request({ dryRun: false }));

    expect(res.status).toBe(401);
    expect(mockNormalizeMemberRoles).not.toHaveBeenCalled();
  });

  it("defaults to a dry run when the body omits dryRun", async () => {
    const res = await POST(request({}));

    expect(res.status).toBe(200);
    expect(mockNormalizeMemberRoles).toHaveBeenCalledWith(mockPrisma, { dryRun: true });
  });

  it("defaults to a dry run when there is no body at all", async () => {
    const res = await POST(request());

    expect(res.status).toBe(200);
    expect(mockNormalizeMemberRoles).toHaveBeenCalledWith(mockPrisma, { dryRun: true });
  });

  it("defaults to a dry run when dryRun is any value other than false", async () => {
    await POST(request({ dryRun: "no" }));

    expect(mockNormalizeMemberRoles).toHaveBeenCalledWith(mockPrisma, { dryRun: true });
  });

  it("writes only when dryRun is explicitly false", async () => {
    const res = await POST(request({ dryRun: false }));

    expect(res.status).toBe(200);
    expect(mockNormalizeMemberRoles).toHaveBeenCalledWith(mockPrisma, { dryRun: false });
  });

  it("returns the structured report as JSON", async () => {
    const res = await POST(request({ dryRun: true }));

    await expect(res.json()).resolves.toEqual(REPORT);
  });
});
