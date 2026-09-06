import { describe, expect, it, vi } from "vitest";
import { cleanupEligible, migrateToReady, provisioningStatements } from "../../scripts/preview-automation/database";

describe("independent QA: migration readiness is not HTTP acceptance", () => {
  it("does not report ready while the migration endpoint still returns 202", async () => {
    const ready = vi.fn().mockResolvedValue(true);
    const pause = vi.fn().mockResolvedValue(undefined);
    await expect(migrateToReady(vi.fn().mockResolvedValue(202), ready, pause, 3)).rejects.toThrow(/deadline/);
    expect(ready).not.toHaveBeenCalled();
    expect(pause).toHaveBeenCalledTimes(3);
  });
  it("does not report ready on 200 when asynchronous indexes remain incomplete", async () => {
    await expect(migrateToReady(vi.fn().mockResolvedValue(200), vi.fn().mockResolvedValue(false), vi.fn().mockResolvedValue(undefined), 2)).rejects.toThrow(/deadline/);
  });
  it("resumes after accepted work and completes only after readiness confirmation", async () => {
    const apply = vi.fn().mockResolvedValueOnce(202).mockResolvedValueOnce(200).mockResolvedValueOnce(200);
    const ready = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await expect(migrateToReady(apply, ready, vi.fn().mockResolvedValue(undefined), 3)).resolves.toBeUndefined();
    expect(apply).toHaveBeenCalledTimes(3);
  });
  it.each([301, 401, 403, 404, 500])("aborts immediately on unexpected migration status %s", async status => {
    const apply = vi.fn().mockResolvedValue(status);
    const pause = vi.fn();
    await expect(migrateToReady(apply, vi.fn(), pause, 5)).rejects.toThrow();
    expect(apply).toHaveBeenCalledTimes(1);
    expect(pause).not.toHaveBeenCalled();
  });
  it("does not turn a network failure into readiness", async () => {
    await expect(migrateToReady(vi.fn().mockRejectedValue(new Error("disconnected")), vi.fn(), vi.fn())).rejects.toThrow("disconnected");
  });
});

describe("independent QA: synthetic schema lifecycle boundaries", () => {
  const now = 1_800_000_000_000;
  const idle = { registered: true, activeRuns: 0, closed: false, lastActivity: now - 7 * 86_400_000 };
  it("preserves a closed PR schema while a live run remains", () => {
    expect(cleanupEligible({ ...idle, closed: true, activeRuns: 1 }, now)).toBe(false);
  });
  it("never infers ownership of an unregistered but old closed PR schema", () => {
    expect(cleanupEligible({ ...idle, registered: false, closed: true }, now)).toBe(false);
  });
  it("preserves recent open PR data", () => {
    expect(cleanupEligible({ ...idle, lastActivity: now - 6 * 86_400_000 }, now)).toBe(false);
  });
  it("preserves a closed schema while its provisioner still holds a lease", () => {
    const record = { ...idle, closed: true, leaseExpiresAt: now + 60_000 };
    expect(cleanupEligible(record, now)).toBe(false);
  });
  it.each([NaN, Infinity])("fails closed when the controller lease deadline is invalid: %s", leaseExpiresAt => {
    const record = { ...idle, closed: true, leaseExpiresAt };
    expect(cleanupEligible(record, now)).toBe(false);
  });
  it("permits an otherwise eligible schema only after its controller lease expires", () => {
    const record = { ...idle, closed: true, leaseExpiresAt: now - 1 };
    expect(cleanupEligible(record, now)).toBe(true);
  });
  it.each(["compass_prod", "compass_preview", "public", "compass_pr_1_aaaaaaaaaaaa; DROP SCHEMA public", "compass_pr_01_aaaaaaaaaaaa"])("rejects provisioning outside registered namespace: %s", schema => {
    expect(() => provisioningStatements(schema, "arn:aws:iam::123456789012:role/preview-runtime", "arn:aws:iam::123456789012:role/preview-migration")).toThrow();
  });
  it("rejects an IAM ARN containing SQL delimiters", () => {
    expect(() => provisioningStatements("compass_pr_1_aaaaaaaaaaaa", "arn:aws:iam::123456789012:role/x'; DROP ROLE admin", "arn:aws:iam::123456789012:role/preview-migration")).toThrow();
  });
});
