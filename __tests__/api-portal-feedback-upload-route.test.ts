/**
 * Unit tests for app/api/portal/[orgSlug]/[workspaceSlug]/feedback/upload/route.ts.
 *
 * Prisma and lib/portal-auth's getPortalSession are mocked following the same
 * pattern as __tests__/api-portal-feedback-route.test.ts. @vercel/blob's put()
 * is mocked too — there's no existing @vercel/blob mock precedent in this repo,
 * so this test file establishes one: a simple vi.fn() returning a fake blob URL.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockWorkspace = { findFirst: vi.fn() };

const mockPrisma = {
  workspace: mockWorkspace,
};

vi.mock("@/lib/db", () => ({
  default: () => mockPrisma,
}));

vi.mock("@/lib/portal-auth", () => ({
  getPortalSession: vi.fn(),
}));

const mockPut = vi.fn();
vi.mock("@vercel/blob", () => ({
  put: (...args: unknown[]) => mockPut(...args),
}));

import { getPortalSession } from "@/lib/portal-auth";
import { POST } from "@/app/api/portal/[orgSlug]/[workspaceSlug]/feedback/upload/route";

const mockGetPortalSession = vi.mocked(getPortalSession);

const params = Promise.resolve({ orgSlug: "acme", workspaceSlug: "ws" });

function makeRequest(file: File | null) {
  const form = new FormData();
  if (file) form.append("file", file);
  return new NextRequest("http://localhost/api/portal/acme/ws/feedback/upload", {
    method: "POST",
    body: form,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPut.mockResolvedValue({
    url: "https://abc123.public.blob.vercel-storage.com/feedback/ws-1/1-screenshot.png",
  });
});

describe("POST /api/portal/[orgSlug]/[workspaceSlug]/feedback/upload", () => {
  it("rejects a disallowed mime type with 400", async () => {
    mockWorkspace.findFirst.mockResolvedValue({
      id: "ws-1",
      feedbackEnabled: true,
      portalAuthRequired: false,
    });
    const file = new File(["#!/bin/sh\necho hi"], "script.sh", { type: "application/x-sh" });

    const res = await POST(makeRequest(file), { params });
    const data = await res.json();

    expect(res.status).toBe(400);
    expect(data.error).toBe("Unsupported file type");
    expect(mockPut).not.toHaveBeenCalled();
  });

  it("rejects a file larger than 10MB with 400", async () => {
    mockWorkspace.findFirst.mockResolvedValue({
      id: "ws-1",
      feedbackEnabled: true,
      portalAuthRequired: false,
    });
    const bigContent = new Uint8Array(10 * 1024 * 1024 + 1);
    const file = new File([bigContent], "big.png", { type: "image/png" });

    const res = await POST(makeRequest(file), { params });
    const data = await res.json();

    expect(res.status).toBe(400);
    expect(data.error).toBe("Max 10MB");
    expect(mockPut).not.toHaveBeenCalled();
  });

  it("403s when feedback is not enabled for the workspace", async () => {
    mockWorkspace.findFirst.mockResolvedValue({
      id: "ws-1",
      feedbackEnabled: false,
      portalAuthRequired: false,
    });
    const file = new File(["data"], "screenshot.png", { type: "image/png" });

    const res = await POST(makeRequest(file), { params });
    const data = await res.json();

    expect(res.status).toBe(403);
    expect(data.error).toBe("Feedback is not enabled for this workspace");
    expect(mockPut).not.toHaveBeenCalled();
  });

  it("401s with PORTAL_AUTH_REQUIRED when portalAuthRequired is true and there is no session", async () => {
    mockWorkspace.findFirst.mockResolvedValue({
      id: "ws-1",
      feedbackEnabled: true,
      portalAuthRequired: true,
    });
    mockGetPortalSession.mockResolvedValue(null);
    const file = new File(["data"], "screenshot.png", { type: "image/png" });

    const res = await POST(makeRequest(file), { params });
    const data = await res.json();

    expect(res.status).toBe(401);
    expect(data.code).toBe("PORTAL_AUTH_REQUIRED");
    expect(mockPut).not.toHaveBeenCalled();
  });

  it("returns { url, filename, fileType, fileSize } on the happy path", async () => {
    mockWorkspace.findFirst.mockResolvedValue({
      id: "ws-1",
      feedbackEnabled: true,
      portalAuthRequired: false,
    });
    const file = new File(["fake-image-bytes"], "screenshot.png", { type: "image/png" });

    const res = await POST(makeRequest(file), { params });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data).toEqual({
      url: "https://abc123.public.blob.vercel-storage.com/feedback/ws-1/1-screenshot.png",
      filename: "screenshot.png",
      fileType: "image/png",
      fileSize: file.size,
    });
    expect(mockPut).toHaveBeenCalledTimes(1);
    const [key, uploadedFile, options] = mockPut.mock.calls[0];
    // The File instance is round-tripped through multipart parsing in
    // req.formData(), so it's a distinct object from `file` (with its own
    // lastModified) — assert on the parsed file's own properties instead.
    expect(key).toMatch(/^feedback\/ws-1\/\d+-screenshot\.png$/);
    expect(uploadedFile.name).toBe("screenshot.png");
    expect(uploadedFile.type).toBe("image/png");
    expect(uploadedFile.size).toBe(file.size);
    expect(options).toEqual({ access: "public" });
  });

  it("sanitizes unsafe characters out of the filename before building the blob key", async () => {
    mockWorkspace.findFirst.mockResolvedValue({
      id: "ws-1",
      feedbackEnabled: true,
      portalAuthRequired: false,
    });
    const file = new File(["data"], "my file (1)@#.png", { type: "image/png" });

    await POST(makeRequest(file), { params });

    const [key] = mockPut.mock.calls[0];
    expect(key).toMatch(/^feedback\/ws-1\/\d+-my_file__1___\.png$/);
  });

  it("404s when the workspace doesn't exist", async () => {
    mockWorkspace.findFirst.mockResolvedValue(null);
    const file = new File(["data"], "screenshot.png", { type: "image/png" });

    const res = await POST(makeRequest(file), { params });

    expect(res.status).toBe(404);
    expect(mockPut).not.toHaveBeenCalled();
  });

  it("400s when no file is provided", async () => {
    mockWorkspace.findFirst.mockResolvedValue({
      id: "ws-1",
      feedbackEnabled: true,
      portalAuthRequired: false,
    });

    const res = await POST(makeRequest(null), { params });
    const data = await res.json();

    expect(res.status).toBe(400);
    expect(data.error).toBe("No file");
  });
});
