import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the DB module so Prisma is never instantiated during tests.
// The factory is called once per vi.mock() — using vi.fn() lets us assert
// call counts in individual tests if needed later.
vi.mock("@/lib/db", () => ({
  default: vi.fn(() => ({
    oKRCycle: {
      create: vi.fn().mockResolvedValue({ id: "cycle-123" }),
    },
    objective: {
      create: vi.fn().mockResolvedValue({ id: "obj-123" }),
      update: vi.fn().mockResolvedValue({ id: "obj-123" }),
    },
    keyResult: {
      create: vi.fn().mockResolvedValue({ id: "kr-123" }),
      update: vi.fn().mockResolvedValue({ id: "kr-123" }),
    },
    checkIn: {
      create: vi.fn().mockResolvedValue({ id: "ci-123" }),
    },
    $transaction: vi.fn().mockResolvedValue([]),
  })),
}));

// Mock Next.js cache and navigation — these are no-ops in unit test context.
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));

// Import actions AFTER mocks are registered so module-level calls to getPrisma()
// (if any) resolve to the mock. Vitest hoists vi.mock() calls automatically.
import {
  createObjective,
  addKeyResult,
  logCheckIn,
} from "@/app/[orgSlug]/[workspaceSlug]/okrs/actions";

// createCycle calls redirect() which throws in Next.js server context.
// It is better tested via E2E. Same applies to actions that are purely
// side-effectful with no Zod validation worth unit-testing.

function makeFormData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
}

// ─── createObjective ─────────────────────────────────────────────────────────

describe("createObjective validation", () => {
  it("throws when title is empty", async () => {
    const fd = makeFormData({ title: "" });
    await expect(
      createObjective("cycle-1", "org", "ws", fd)
    ).rejects.toThrow("Title is required");
  });

  it("throws when title is missing entirely (null from FormData)", async () => {
    // formData.get() returns null for missing keys. Zod v4's z.string() rejects
    // null before reaching the .min(1) message — the error is a type error, not
    // the custom "Title is required" message. Both are validation failures.
    const fd = makeFormData({});
    await expect(
      createObjective("cycle-1", "org", "ws", fd)
    ).rejects.toThrow(); // any Zod error is sufficient here
  });

  it("succeeds with a valid title", async () => {
    const fd = makeFormData({ title: "Ship the MVP", description: "Q1 goal" });
    await expect(
      createObjective("cycle-1", "org", "ws", fd)
    ).resolves.not.toThrow();
  });

  it("succeeds with only title (all other fields optional)", async () => {
    const fd = makeFormData({ title: "Grow retention" });
    await expect(
      createObjective("cycle-1", "org", "ws", fd)
    ).resolves.not.toThrow();
  });
});

// ─── addKeyResult ─────────────────────────────────────────────────────────────

describe("addKeyResult validation", () => {
  it("throws when title is empty", async () => {
    const fd = makeFormData({ title: "", target: "100" });
    await expect(
      addKeyResult("obj-1", "org", "ws", fd)
    ).rejects.toThrow("Title is required");
  });

  it("throws when target is non-numeric", async () => {
    const fd = makeFormData({ title: "MRR", target: "abc" });
    await expect(
      addKeyResult("obj-1", "org", "ws", fd)
    ).rejects.toThrow();
  });

  it("throws when target is zero (must be positive)", async () => {
    const fd = makeFormData({ title: "MRR", target: "0" });
    await expect(
      addKeyResult("obj-1", "org", "ws", fd)
    ).rejects.toThrow();
  });

  it("throws when target is negative", async () => {
    const fd = makeFormData({ title: "MRR", target: "-5" });
    await expect(
      addKeyResult("obj-1", "org", "ws", fd)
    ).rejects.toThrow();
  });

  it("succeeds with valid title and positive target", async () => {
    const fd = makeFormData({ title: "NPS Score", target: "50", unit: "points" });
    await expect(
      addKeyResult("obj-1", "org", "ws", fd)
    ).resolves.not.toThrow();
  });

  it("succeeds without a unit (unit is optional)", async () => {
    const fd = makeFormData({ title: "Revenue", target: "1000000" });
    await expect(
      addKeyResult("obj-1", "org", "ws", fd)
    ).resolves.not.toThrow();
  });
});

// ─── logCheckIn ───────────────────────────────────────────────────────────────

describe("logCheckIn validation", () => {
  it("throws when value is not a number", async () => {
    const fd = makeFormData({ value: "not-a-number" });
    await expect(
      logCheckIn("kr-1", "org", "ws", fd)
    ).rejects.toThrow();
  });

  it("accepts a missing value as 0 (Zod v4 coerces null to 0)", async () => {
    // Zod v4's z.coerce.number() coerces null → 0. This is a known Zod v4
    // behavior difference from v3. The action succeeds and records 0 as the
    // check-in value. If null-as-missing should be rejected, add
    // .refine(v => v !== null) or use z.string().pipe(z.coerce.number()) instead.
    const fd = makeFormData({});
    await expect(
      logCheckIn("kr-1", "org", "ws", fd)
    ).resolves.not.toThrow();
  });

  it("succeeds with a numeric value", async () => {
    const fd = makeFormData({ value: "42" });
    await expect(
      logCheckIn("kr-1", "org", "ws", fd)
    ).resolves.not.toThrow();
  });

  it("succeeds with a numeric value and optional note", async () => {
    const fd = makeFormData({ value: "42", note: "Good week!" });
    await expect(
      logCheckIn("kr-1", "org", "ws", fd)
    ).resolves.not.toThrow();
  });

  it("accepts zero as a valid value", async () => {
    const fd = makeFormData({ value: "0" });
    await expect(
      logCheckIn("kr-1", "org", "ws", fd)
    ).resolves.not.toThrow();
  });

  it("accepts negative values (progress can regress)", async () => {
    const fd = makeFormData({ value: "-5" });
    await expect(
      logCheckIn("kr-1", "org", "ws", fd)
    ).resolves.not.toThrow();
  });
});
