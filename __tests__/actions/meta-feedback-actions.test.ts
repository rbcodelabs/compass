import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockFeedbackItem = {
  create: vi.fn(),
};

const mockWorkspace = {
  findFirst: vi.fn(),
};

const mockPrisma = {
  feedbackItem: mockFeedbackItem,
  workspace: mockWorkspace,
};

// vi.mock factories are hoisted above regular top-level declarations, so a
// plain `const mockRevalidatePath = vi.fn()` referenced directly inside a
// factory hits the TDZ. vi.hoisted() runs during the hoisting phase itself,
// initializing it early enough to be safely captured below.
const mockRevalidatePath = vi.hoisted(() => vi.fn());

vi.mock("@/lib/db", () => ({
  default: vi.fn(() => mockPrisma),
}));

vi.mock("next/cache", () => ({ revalidatePath: mockRevalidatePath }));

vi.mock("@/auth", () => ({
  auth: vi.fn(),
}));

import { auth } from "@/auth";
import { sendCompassFeedback } from "@/lib/meta-feedback-actions";

const mockAuth = vi.mocked(auth);

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();

  mockAuth.mockResolvedValue({
    user: { id: "user-1", name: "Dev User", email: "dev@localhost.dev" },
  } as ReturnType<typeof auth> extends Promise<infer T> ? T : never);
  mockWorkspace.findFirst.mockResolvedValue({ id: "meta-ws-1" });
  mockFeedbackItem.create.mockResolvedValue({ id: "fb-meta-1" });
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("sendCompassFeedback", () => {
  it("resolves the default rbcodelabs/compass workspace when env vars are unset", async () => {
    const result = await sendCompassFeedback({ title: "Bug report", description: "", type: "BUG" });

    expect(mockWorkspace.findFirst).toHaveBeenCalledWith({
      where: { slug: "compass", organization: { slug: "rbcodelabs" } },
      select: { id: true },
    });
    expect(result).toEqual({ ok: true, id: "fb-meta-1" });
  });

  it("creates the feedback item against the resolved target workspace with the session identity", async () => {
    await sendCompassFeedback({ title: "Bug report", description: "Steps to repro", type: "BUG" });

    expect(mockFeedbackItem.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          workspaceId: "meta-ws-1",
          title: "Bug report",
          description: "Steps to repro",
          type: "BUG",
          submitterName: "Dev User",
          submitterEmail: "dev@localhost.dev",
        }),
      })
    );
  });

  it("revalidates the target workspace's feedback path, not the caller's current path", async () => {
    await sendCompassFeedback({ title: "Idea", description: "", type: "IDEA" });
    expect(mockRevalidatePath).toHaveBeenCalledWith("/rbcodelabs/compass/feedback");
  });

  it("returns an Unauthorized error (not a thrown exception) when there is no session", async () => {
    mockAuth.mockResolvedValue(null as never);
    const result = await sendCompassFeedback({ title: "Idea", description: "", type: "IDEA" });
    expect(result).toEqual({ ok: false, error: "Unauthorized" });
    expect(mockFeedbackItem.create).not.toHaveBeenCalled();
  });

  it("returns a validation error for a blank title without touching the DB", async () => {
    const result = await sendCompassFeedback({ title: "   ", description: "", type: "IDEA" });
    expect(result).toEqual({ ok: false, error: "Title is required" });
    expect(mockWorkspace.findFirst).not.toHaveBeenCalled();
    expect(mockFeedbackItem.create).not.toHaveBeenCalled();
  });

  it("returns a graceful error (not an unhandled throw) when the target workspace is missing", async () => {
    mockWorkspace.findFirst.mockResolvedValue(null);

    const result = await sendCompassFeedback({ title: "Idea", description: "", type: "IDEA" });

    expect(result).toEqual({
      ok: false,
      error: "Feedback target workspace (rbcodelabs/compass) was not found",
    });
    expect(mockFeedbackItem.create).not.toHaveBeenCalled();
  });

  it("propagates DB errors", async () => {
    mockFeedbackItem.create.mockRejectedValue(new Error("DB error"));
    await expect(
      sendCompassFeedback({ title: "Idea", description: "", type: "IDEA" })
    ).rejects.toThrow("DB error");
  });

  it("respects FEEDBACK_TARGET_ORG_SLUG / FEEDBACK_TARGET_WORKSPACE_SLUG overrides", async () => {
    // The target slugs are read into module-level constants at import time,
    // so proving the override works requires a fresh module instance.
    vi.resetModules();
    process.env.FEEDBACK_TARGET_ORG_SLUG = "other-org";
    process.env.FEEDBACK_TARGET_WORKSPACE_SLUG = "other-workspace";

    const { sendCompassFeedback: sendWithOverride } = await import("@/lib/meta-feedback-actions");
    await sendWithOverride({ title: "Idea", description: "", type: "IDEA" });

    expect(mockWorkspace.findFirst).toHaveBeenCalledWith({
      where: { slug: "other-workspace", organization: { slug: "other-org" } },
      select: { id: true },
    });
  });
});
