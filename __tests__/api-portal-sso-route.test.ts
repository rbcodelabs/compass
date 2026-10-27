/**
 * Unit tests for app/api/portal/[orgSlug]/[workspaceSlug]/sso/route.ts — the cookie-based popup
 * exchange. Focus: the confirmation page must HTML-escape the account email.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockWorkspaceFindFirst = vi.fn();
vi.mock("@/lib/db", () => ({
  default: () => ({ workspace: { findFirst: mockWorkspaceFindFirst } }),
}));
vi.mock("@/lib/crypto-secrets", () => ({ decrypt: vi.fn(() => "shared-secret") }));
vi.mock("@/lib/portal-sso", () => ({ verifySsoToken: vi.fn() }));
vi.mock("@/lib/portal-auth", () => ({
  createPortalSession: vi.fn(),
  upsertPortalAccountFromSsoIdentity: vi.fn(),
}));

import { verifySsoToken } from "@/lib/portal-sso";
import { upsertPortalAccountFromSsoIdentity } from "@/lib/portal-auth";
import { GET } from "@/app/api/portal/[orgSlug]/[workspaceSlug]/sso/route";

function request(query: string) {
  return new NextRequest(`http://localhost/api/portal/acme/ws/sso${query}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SSO_SECRET_ENCRYPTION_KEY = "test-key";
  mockWorkspaceFindFirst.mockResolvedValue({ id: "w1", ssoEnabled: true, ssoSecretEncrypted: "enc" });
});

describe("GET /api/portal/[orgSlug]/[workspaceSlug]/sso", () => {
  it("HTML-escapes the account email in the confirmation page", async () => {
    const malicious = "<img src=x onerror=alert(1)>@example.com";
    vi.mocked(verifySsoToken).mockResolvedValue({ email: malicious });
    vi.mocked(upsertPortalAccountFromSsoIdentity).mockResolvedValue({
      id: "a1",
      email: malicious,
      name: null,
    });

    const res = await GET(request("?token=t"), {
      params: Promise.resolve({ orgSlug: "acme", workspaceSlug: "ws" }),
    });

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain("<img");
    expect(body).toContain("&lt;img src=x onerror=alert(1)&gt;@example.com");
  });

  it("renders a normal address unchanged", async () => {
    vi.mocked(verifySsoToken).mockResolvedValue({ email: "jane@example.com" });
    vi.mocked(upsertPortalAccountFromSsoIdentity).mockResolvedValue({
      id: "a1",
      email: "jane@example.com",
      name: null,
    });

    const res = await GET(request("?token=t"), {
      params: Promise.resolve({ orgSlug: "acme", workspaceSlug: "ws" }),
    });

    expect(await res.text()).toContain("Signed in as jane@example.com.");
  });
});
