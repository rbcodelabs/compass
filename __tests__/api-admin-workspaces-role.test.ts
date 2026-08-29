/**
 * Unit tests for app/api/admin/workspaces/route.ts.
 *
 * This is the raw-SQL provisioning endpoint (gated by MIGRATION_SECRET, same
 * trust boundary as the migrate route). It seeds the requesting user as a
 * member of the workspace it provisions.
 *
 * Invariant under test: the membership INSERT writes a real WorkspaceRole.
 * It used to write a lowercase "owner", which is not in
 * WorkspaceRole ("ADMIN" | "MEMBER"), and which the strict ADMIN check in
 * resolveWorkspaceAdmin then rejected -- so the person the endpoint had just
 * provisioned could not administer their own workspace.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const mockClient = {
  query: vi.fn(),
  release: vi.fn(),
};

const mockPool = {
  connect: vi.fn(async () => mockClient),
  end: vi.fn(async () => undefined),
};

// The route calls these with new, so the mocks have to be constructible --
// an arrow function is not.
vi.mock("pg", () => ({
  Pool: function Pool() {
    return mockPool;
  },
}));

vi.mock("@aws-sdk/dsql-signer", () => ({
  DsqlSigner: function DsqlSigner() {
    return { getDbConnectAdminAuthToken: async () => "token" };
  },
}));

vi.mock("@vercel/functions/oidc", () => ({
  awsCredentialsProvider: vi.fn(() => vi.fn()),
}));

vi.mock("@/lib/schema", () => ({
  getActiveSchema: () => "compass_test",
}));

import { POST } from "@/app/api/admin/workspaces/route";

const ORIGINAL_ENV = { ...process.env };

function request(body: unknown, secret = "test-migration-secret") {
  return new NextRequest("http://localhost/api/admin/workspaces", {
    method: "POST",
    body: JSON.stringify(body),
    headers: {
      "Content-Type": "application/json",
      "x-migration-secret": secret,
    },
  });
}

const BODY = {
  orgSlug: "rbcodelabs",
  orgName: "RB Code Labs",
  workspaceSlug: "compass",
  workspaceName: "Compass",
  userEmail: "rick@rbcodelabs.com",
};

/** Finds the first query whose SQL contains all the given fragments. */
function findQuery(...fragments: string[]): string | undefined {
  const call = mockClient.query.mock.calls.find(([sql]) =>
    typeof sql === "string" && fragments.every((f) => sql.includes(f))
  );
  return call ? (call[0] as string) : undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.MIGRATION_SECRET = "test-migration-secret";

  // Existing org, workspace, and API key; no existing membership, so the
  // membership INSERT is exercised.
  mockClient.query.mockImplementation(async (sql: string) => {
    if (sql.includes("users WHERE email")) return { rows: [{ id: "user-1" }] };
    if (sql.includes("organizations WHERE slug")) return { rows: [{ id: "org-1" }] };
    if (sql.includes("workspaces WHERE organization_id")) return { rows: [{ id: "ws-1" }] };
    if (sql.includes("workspace_members WHERE workspace_id")) return { rows: [] };
    if (sql.includes("api_keys WHERE user_id")) return { rows: [{ id: "key-1" }] };
    return { rows: [] };
  });
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("POST /api/admin/workspaces", () => {
  it("rejects a request without the correct x-migration-secret header", async () => {
    const res = await POST(request(BODY, "wrong-secret"));

    expect(res.status).toBe(401);
    expect(mockClient.query).not.toHaveBeenCalled();
  });

  it("seeds the workspace membership with the ADMIN role, not owner", async () => {
    const res = await POST(request(BODY));
    expect(res.status).toBe(200);

    const insert = findQuery("INSERT INTO", "workspace_members");

    expect(insert).toBeDefined();
    expect(insert).toContain("ADMIN");
    expect(insert).not.toContain("owner");
  });

  it("does not re-insert a membership that already exists", async () => {
    mockClient.query.mockImplementation(async (sql: string) => {
      if (sql.includes("users WHERE email")) return { rows: [{ id: "user-1" }] };
      if (sql.includes("organizations WHERE slug")) return { rows: [{ id: "org-1" }] };
      if (sql.includes("workspaces WHERE organization_id")) return { rows: [{ id: "ws-1" }] };
      if (sql.includes("workspace_members WHERE workspace_id")) return { rows: [{ id: "wm-1" }] };
      if (sql.includes("api_keys WHERE user_id")) return { rows: [{ id: "key-1" }] };
      return { rows: [] };
    });

    await POST(request(BODY));

    expect(findQuery("INSERT INTO", "workspace_members")).toBeUndefined();
  });
});
