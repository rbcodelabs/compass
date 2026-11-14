import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mockPut = vi.hoisted(() => vi.fn());
const mockAuth = vi.hoisted(() => vi.fn());
const mockResolveWorkspaceAdmin = vi.hoisted(() => vi.fn());

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/storage/public-store", () => ({ getPublicFileStore: () => ({ put: mockPut }) }));
vi.mock("@/lib/permissions", async () => {
  const actual = await vi.importActual<typeof import("@/lib/permissions")>("@/lib/permissions");
  return { ...actual, resolveWorkspaceAdmin: mockResolveWorkspaceAdmin };
});

import { PermissionError } from "@/lib/permissions";
import { POST } from "@/app/api/branding/logo/route";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>');

function request(bytes: Uint8Array, opts: { type?: string; name?: string; workspace?: boolean } = {}) {
  const form = new FormData();
  if (opts.workspace !== false) {
    form.append("orgSlug", "org");
    form.append("workspaceSlug", "ws");
  }
  form.append("file", new File([bytes.slice().buffer as ArrayBuffer], opts.name ?? "logo.png", { type: opts.type ?? "image/png" }));
  return new NextRequest("http://localhost/api/branding/logo", { method: "POST", body: form });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "user-1" } });
  mockResolveWorkspaceAdmin.mockResolvedValue({ workspaceId: "ws-1" });
  mockPut.mockResolvedValue({ url: "https://store.example/branding/x-logo.png" });
});

describe("POST /api/branding/logo", () => {
  it("rejects an unauthenticated caller", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(request(PNG));
    expect(res.status).toBe(401);
    expect(mockPut).not.toHaveBeenCalled();
  });

  it("requires a workspace to be named", async () => {
    const res = await POST(request(PNG, { workspace: false }));
    expect(res.status).toBe(400);
    expect(mockPut).not.toHaveBeenCalled();
  });

  it("rejects a non-admin member", async () => {
    mockResolveWorkspaceAdmin.mockRejectedValue(new PermissionError("Forbidden: workspace admin required"));
    const res = await POST(request(PNG));
    expect(res.status).toBe(403);
    expect(mockPut).not.toHaveBeenCalled();
  });

  it("rejects a non-member as not found", async () => {
    mockResolveWorkspaceAdmin.mockRejectedValue(new PermissionError("Workspace not found"));
    const res = await POST(request(PNG));
    expect(res.status).toBe(404);
    expect(mockPut).not.toHaveBeenCalled();
  });

  it("rejects SVG even when the declared type says png", async () => {
    const res = await POST(request(SVG, { type: "image/png", name: "logo.png" }));
    expect(res.status).toBe(400);
    expect(mockPut).not.toHaveBeenCalled();
  });

  it("rejects SVG declared as svg", async () => {
    const res = await POST(request(SVG, { type: "image/svg+xml", name: "logo.svg" }));
    expect(res.status).toBe(400);
    expect(mockPut).not.toHaveBeenCalled();
  });

  it("ignores a non-image declared type when the bytes are a real PNG", async () => {
    const res = await POST(request(PNG, { type: "text/html", name: "x.html" }));
    expect(res.status).toBe(200);
  });

  it("stores a real PNG under a server-generated key with the sniffed content type", async () => {
    const res = await POST(request(PNG, { type: "image/svg+xml", name: "../../evil.svg" }));
    expect(res.status).toBe(200);
    expect(mockPut).toHaveBeenCalledTimes(1);
    const [pathname, , options] = mockPut.mock.calls[0];
    expect(pathname).toMatch(/^branding\/[0-9a-f-]{36}-logo\.png$/);
    expect(pathname).not.toContain("evil");
    expect(options).toEqual({ contentType: "image/png" });
    expect(await res.json()).toEqual({ url: "https://store.example/branding/x-logo.png" });
  });
});
