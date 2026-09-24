import { describe, expect, it, vi } from "vitest";
import { signUpdatesToken, readUpdatesToken } from "./workspace-updates-token";
describe("catch-up snapshot receipts", () => {
  it("rejects forged and cross-user receipts", () => {
    vi.stubEnv("AUTH_SECRET", "synthetic-test-secret");
    const token = signUpdatesToken({
      workspaceId: "w",
      userId: "u",
      upper: 10,
      before: 5,
      mode: "unread",
      baseline: "2026-09-23T00:00:00Z",
      readRevision: 0,
      complete: false,
    });
    expect(readUpdatesToken(token, "w", "u").upper).toBe(10);
    expect(() => readUpdatesToken(token, "w", "other")).toThrow();
    expect(() => readUpdatesToken(`${token}x`, "w", "u")).toThrow();
    vi.unstubAllEnvs();
  });
});
