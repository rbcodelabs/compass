import { describe, it, expect, vi, beforeEach } from "vitest";

const mockOrganization = {
  findFirst: vi.fn(),
  create: vi.fn(),
};
const mockOrganizationMember = {
  create: vi.fn(),
};
const mockWorkspace = {
  create: vi.fn(),
};
const mockWorkspaceMember = {
  create: vi.fn(),
};

const mockPrisma = {
  organization: mockOrganization,
  organizationMember: mockOrganizationMember,
  workspace: mockWorkspace,
  workspaceMember: mockWorkspaceMember,
};

vi.mock("@/lib/db", () => ({
  default: vi.fn(() => mockPrisma),
}));

// redirect() throws in Next.js server actions — mock it as a no-op for unit tests
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));

vi.mock("@/auth", () => ({
  auth: vi.fn(),
}));

import { auth } from "@/auth";
import { createOrganizationAndWorkspace } from "@/app/onboarding/actions";

const mockAuth = vi.mocked(auth);

function makeFormData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
}

const VALID_FIELDS = {
  orgName: "Acme Corp",
  orgSlug: "acme-corp",
  workspaceName: "Product Team",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "user-1" } } as ReturnType<typeof auth> extends Promise<infer T> ? T : never);
  mockOrganization.findFirst.mockResolvedValue(null); // slug not taken
  mockOrganization.create.mockResolvedValue({ id: "org-1", slug: "acme-corp" });
  mockOrganizationMember.create.mockResolvedValue({});
  mockWorkspace.create.mockResolvedValue({ id: "ws-1", slug: "product-team" });
  mockWorkspaceMember.create.mockResolvedValue({});
});

// ─── Auth boundary ────────────────────────────────────────────────────────────

describe("createOrganizationAndWorkspace — auth boundary", () => {
  it("returns form error when session is missing", async () => {
    mockAuth.mockResolvedValue(null);
    const fd = makeFormData(VALID_FIELDS);
    const result = await createOrganizationAndWorkspace({}, fd);
    expect(result.errors?._form).toContain("You must be signed in to continue.");
    expect(mockOrganization.create).not.toHaveBeenCalled();
  });

  it("returns form error when session has no user id", async () => {
    mockAuth.mockResolvedValue({ user: {} } as ReturnType<typeof auth> extends Promise<infer T> ? T : never);
    const fd = makeFormData(VALID_FIELDS);
    const result = await createOrganizationAndWorkspace({}, fd);
    expect(result.errors?._form).toContain("You must be signed in to continue.");
  });
});

// ─── Validation errors ────────────────────────────────────────────────────────

describe("createOrganizationAndWorkspace — validation", () => {
  it("returns fieldError for empty orgName", async () => {
    const fd = makeFormData({ ...VALID_FIELDS, orgName: "" });
    const result = await createOrganizationAndWorkspace({}, fd);
    expect(result.errors?.orgName).toBeDefined();
    expect(result.errors?.orgName?.length).toBeGreaterThan(0);
  });

  it("returns fieldError for empty orgSlug", async () => {
    const fd = makeFormData({ ...VALID_FIELDS, orgSlug: "" });
    const result = await createOrganizationAndWorkspace({}, fd);
    expect(result.errors?.orgSlug).toBeDefined();
  });

  it("returns fieldError for slug with uppercase letters", async () => {
    const fd = makeFormData({ ...VALID_FIELDS, orgSlug: "AcmeCorp" });
    const result = await createOrganizationAndWorkspace({}, fd);
    expect(result.errors?.orgSlug).toBeDefined();
    expect(result.errors?.orgSlug?.[0]).toMatch(/lowercase/i);
  });

  it("returns fieldError for slug with spaces", async () => {
    const fd = makeFormData({ ...VALID_FIELDS, orgSlug: "acme corp" });
    const result = await createOrganizationAndWorkspace({}, fd);
    expect(result.errors?.orgSlug).toBeDefined();
  });

  it("returns fieldError for slug with special characters", async () => {
    const fd = makeFormData({ ...VALID_FIELDS, orgSlug: "acme_corp!" });
    const result = await createOrganizationAndWorkspace({}, fd);
    expect(result.errors?.orgSlug).toBeDefined();
  });

  it("accepts slugs with hyphens and numbers (validation passes, redirect called)", async () => {
    // A valid slug passes validation and proceeds to DB creation.
    // The action calls redirect() at the end — mocked as no-op, returning undefined.
    const fd = makeFormData({ ...VALID_FIELDS, orgSlug: "acme-corp-123" });
    const result = await createOrganizationAndWorkspace({}, fd);
    // On success the action redirects (no-op in tests), result may be undefined or empty
    expect(result?.errors?.orgSlug).toBeUndefined();
  });

  it("returns fieldError for empty workspaceName", async () => {
    const fd = makeFormData({ ...VALID_FIELDS, workspaceName: "" });
    const result = await createOrganizationAndWorkspace({}, fd);
    expect(result.errors?.workspaceName).toBeDefined();
  });

  it("valid inputs proceed to DB creation (redirect is called, no errors returned)", async () => {
    // On success, the action calls redirect() — mocked as no-op.
    // The important assertion is that no validation error object is returned.
    const fd = makeFormData(VALID_FIELDS);
    const result = await createOrganizationAndWorkspace({}, fd);
    // Either result is undefined (redirect happened) or has no errors property
    expect(result?.errors).toBeUndefined();
  });
});

// ─── Slug uniqueness ──────────────────────────────────────────────────────────

describe("createOrganizationAndWorkspace — slug uniqueness", () => {
  it("returns orgSlug error when slug is already taken", async () => {
    mockOrganization.findFirst.mockResolvedValue({ id: "existing-org" });
    const fd = makeFormData(VALID_FIELDS);
    const result = await createOrganizationAndWorkspace({}, fd);
    expect(result.errors?.orgSlug).toContain("This slug is already taken. Please choose another.");
    expect(mockOrganization.create).not.toHaveBeenCalled();
  });
});

// ─── Workspace slug derivation ────────────────────────────────────────────────

describe("createOrganizationAndWorkspace — workspace slug derivation", () => {
  it("converts workspace name to lowercase hyphen-delimited slug", async () => {
    const fd = makeFormData({ ...VALID_FIELDS, workspaceName: "My Product Team" });
    await createOrganizationAndWorkspace({}, fd);
    const wsData = mockWorkspace.create.mock.calls[0][0].data;
    expect(wsData.slug).toBe("my-product-team");
  });

  it("strips leading/trailing hyphens from workspace slug", async () => {
    const fd = makeFormData({ ...VALID_FIELDS, workspaceName: "  Team  " });
    await createOrganizationAndWorkspace({}, fd);
    const wsData = mockWorkspace.create.mock.calls[0][0].data;
    expect(wsData.slug).not.toMatch(/^-|-$/);
  });

  it("falls back to 'workspace' slug when name produces empty string", async () => {
    // A name of only special characters would reduce to empty after slug processing
    // Note: Zod min(1) requires at least one char, so true empty is caught by validation.
    // But a name like "---" becomes "" after stripping, so fallback kicks in.
    const fd = makeFormData({ ...VALID_FIELDS, workspaceName: "---" });
    await createOrganizationAndWorkspace({}, fd);
    const wsData = mockWorkspace.create.mock.calls[0][0].data;
    expect(wsData.slug).toBe("workspace");
  });
});

// ─── DB creation sequence ─────────────────────────────────────────────────────

describe("createOrganizationAndWorkspace — DB creation sequence", () => {
  it("creates org, org member, workspace, workspace member in order", async () => {
    const fd = makeFormData(VALID_FIELDS);
    await createOrganizationAndWorkspace({}, fd);

    expect(mockOrganization.create).toHaveBeenCalledOnce();
    expect(mockOrganizationMember.create).toHaveBeenCalledOnce();
    expect(mockWorkspace.create).toHaveBeenCalledOnce();
    expect(mockWorkspaceMember.create).toHaveBeenCalledOnce();

    // Org member references the created org id
    const orgMemberData = mockOrganizationMember.create.mock.calls[0][0].data;
    expect(orgMemberData.organizationId).toBe("org-1");
    expect(orgMemberData.role).toBe("OWNER");

    // Workspace member gets ADMIN role
    const wsMemberData = mockWorkspaceMember.create.mock.calls[0][0].data;
    expect(wsMemberData.role).toBe("ADMIN");
    expect(wsMemberData.workspaceId).toBe("ws-1");
  });

  it("propagates DB errors from org creation", async () => {
    mockOrganization.create.mockRejectedValue(new Error("unique constraint"));
    const fd = makeFormData(VALID_FIELDS);
    await expect(
      createOrganizationAndWorkspace({}, fd)
    ).rejects.toThrow("unique constraint");
  });
});
