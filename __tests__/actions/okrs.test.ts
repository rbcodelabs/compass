import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the DB module so Prisma is never instantiated during tests.
vi.mock("@/lib/db", () => ({
  default: vi.fn(() => ({
    oKRCycle: {
      create: vi.fn().mockResolvedValue({ id: "cycle-123" }),
    },
    objective: {
      create: vi.fn().mockResolvedValue({ id: "obj-123" }),
      update: vi.fn().mockResolvedValue({ id: "obj-123", status: "ON_TRACK" }),
      delete: vi.fn().mockResolvedValue({ id: "obj-123" }),
    },
    keyResult: {
      create: vi.fn().mockResolvedValue({ id: "kr-123" }),
      update: vi.fn().mockResolvedValue({ id: "kr-123" }),
      delete: vi.fn().mockResolvedValue({ id: "kr-123" }),
    },
    checkIn: {
      create: vi.fn().mockResolvedValue({ id: "ci-123" }),
    },
    $transaction: vi.fn().mockResolvedValue([]),
  })),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));

import {
  createObjective,
  addKeyResult,
  logCheckIn,
  updateObjectiveStatus,
  deleteObjective,
  deleteKeyResult,
  reorderObjective,
  reorderKeyResult,
  setObjectiveParentKR,
} from "@/app/[orgSlug]/[workspaceSlug]/okrs/actions";

function makeFormData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
}

// ─── createObjective ─────────────────────────────────────────────────────────

describe("createObjective", () => {
  it("throws when title is empty", async () => {
    const fd = makeFormData({ title: "" });
    await expect(
      createObjective("cycle-1", "org", "ws", fd)
    ).rejects.toThrow("Title is required");
  });

  it("throws when title is missing entirely", async () => {
    const fd = makeFormData({});
    await expect(
      createObjective("cycle-1", "org", "ws", fd)
    ).rejects.toThrow();
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

  it("accepts an optional description field", async () => {
    const fd = makeFormData({ title: "Launch feature", description: "Details here" });
    await expect(
      createObjective("cycle-1", "org", "ws", fd)
    ).resolves.not.toThrow();
  });
});

// ─── addKeyResult ─────────────────────────────────────────────────────────────

describe("addKeyResult", () => {
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

  it("throws when target is missing", async () => {
    const fd = makeFormData({ title: "Revenue" });
    // null coerced to NaN — not a valid number
    await expect(
      addKeyResult("obj-1", "org", "ws", fd)
    ).rejects.toThrow();
  });
});

// ─── logCheckIn ───────────────────────────────────────────────────────────────

describe("logCheckIn", () => {
  it("throws when value is not a number", async () => {
    const fd = makeFormData({ value: "not-a-number" });
    await expect(
      logCheckIn("kr-1", "org", "ws", fd)
    ).rejects.toThrow();
  });

  it("accepts a missing value as 0 (Zod v4 coerces null to 0)", async () => {
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

// ─── updateObjectiveStatus ────────────────────────────────────────────────────

describe("updateObjectiveStatus", () => {
  it("accepts ON_TRACK status", async () => {
    await expect(
      updateObjectiveStatus("obj-1", "ON_TRACK", "org", "ws")
    ).resolves.not.toThrow();
  });

  it("accepts AT_RISK status", async () => {
    await expect(
      updateObjectiveStatus("obj-1", "AT_RISK", "org", "ws")
    ).resolves.not.toThrow();
  });

  it("accepts OFF_TRACK status", async () => {
    await expect(
      updateObjectiveStatus("obj-1", "OFF_TRACK", "org", "ws")
    ).resolves.not.toThrow();
  });

  it("accepts COMPLETE status", async () => {
    await expect(
      updateObjectiveStatus("obj-1", "COMPLETE", "org", "ws")
    ).resolves.not.toThrow();
  });

  it("throws when an invalid status is provided", async () => {
    await expect(
      // @ts-expect-error — intentionally passing invalid value
      updateObjectiveStatus("obj-1", "INVALID_STATUS", "org", "ws")
    ).rejects.toThrow("Invalid status value");
  });
});

// ─── deleteObjective ──────────────────────────────────────────────────────────

describe("deleteObjective", () => {
  it("resolves without error for a valid id", async () => {
    await expect(
      deleteObjective("obj-1", "/org/ws/okrs")
    ).resolves.not.toThrow();
  });
});

// ─── deleteKeyResult ──────────────────────────────────────────────────────────

describe("deleteKeyResult", () => {
  it("resolves without error for a valid id", async () => {
    await expect(
      deleteKeyResult("kr-1", "/org/ws/okrs")
    ).resolves.not.toThrow();
  });
});

// ─── reorderObjective ─────────────────────────────────────────────────────────

describe("reorderObjective", () => {
  it("resolves without error", async () => {
    await expect(
      reorderObjective("obj-1", 3, "/org/ws/okrs")
    ).resolves.not.toThrow();
  });
});

// ─── reorderKeyResult ─────────────────────────────────────────────────────────

describe("reorderKeyResult", () => {
  it("resolves without error", async () => {
    await expect(
      reorderKeyResult("kr-1", 2, "/org/ws/okrs")
    ).resolves.not.toThrow();
  });
});

// ─── setObjectiveParentKR ─────────────────────────────────────────────────────

describe("setObjectiveParentKR", () => {
  it("links an objective to a key result", async () => {
    await expect(
      setObjectiveParentKR("obj-1", "kr-1", "org", "ws")
    ).resolves.not.toThrow();
  });

  it("clears the parent key result when null is passed", async () => {
    await expect(
      setObjectiveParentKR("obj-1", null, "org", "ws")
    ).resolves.not.toThrow();
  });
});
