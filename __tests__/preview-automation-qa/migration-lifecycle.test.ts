import { describe, expect, it, vi } from "vitest";
import { cleanupEligible, migrateToReady, previewMigrationsReady, provisioningStatements } from "../../scripts/preview-automation/database";

/**
 * Production's observed attempt history, reduced to the two status fields the
 * readiness gate reads: four migrations that failed at least once and then
 * succeeded, so nothing is stuck and the schema is ready.
 */
const RETRIED_BUT_RESOLVED = {
  pending: [],
  unresolvedMigrations: [],
  manifest: ["039_native_decision_gates", "042_native_decision_gates_repair", "047_research_voice_control_plane", "049_agent_identity", "050_pm_interviews", "055_oauth_authorization_server"],
  notApplicable: [],
  retriedMigrations: [
    { name: "047_research_voice_control_plane", failedAttempts: 2 },
    { name: "049_agent_identity", failedAttempts: 1 },
    { name: "050_pm_interviews", failedAttempts: 1 },
    { name: "055_oauth_authorization_server", failedAttempts: 2 },
  ],
  // The forensic list the gate used to read, which never clears once a
  // migration has failed even once.
  incompleteMigrations: [
    "047_research_voice_control_plane",
    "047_research_voice_control_plane",
    "049_agent_identity",
    "050_pm_interviews",
    "055_oauth_authorization_server",
    "055_oauth_authorization_server",
  ],
};

describe("independent QA: preview readiness distinguishes stuck migrations from retried ones", () => {
  // The deadlock this predicate exists to prevent. Gating on
  // `incompleteMigrations` meant one failed-then-retried migration made the
  // condition unsatisfiable, so `migrateToReady` burned all 180 attempts and
  // failed provisioning on a schema that was actually finished.
  it("reports ready when every unfinished attempt was followed by a successful retry", () => {
    expect(RETRIED_BUT_RESOLVED.incompleteMigrations).not.toHaveLength(0);
    expect(previewMigrationsReady(RETRIED_BUT_RESOLVED, 0)).toBe(true);
  });

  it("does not deadlock migrateToReady on a retried-but-resolved history", async () => {
    const pause = vi.fn().mockResolvedValue(undefined);
    await expect(
      migrateToReady(vi.fn().mockResolvedValue(200), async () => previewMigrationsReady(RETRIED_BUT_RESOLVED, 0), pause, 180),
    ).resolves.toBeUndefined();
    expect(pause).not.toHaveBeenCalled();
  });

  // The second deadlock, one layer down. A decision migration records its
  // unfinished attempt row before running any DDL, so a 039 that failed and was
  // then repaired by 042 is unresolved forever *and* permanently not pending —
  // no retry can ever clear it. Blocking on it would exhaust the loop exactly as
  // `incompleteMigrations` did.
  it("reports ready when the only unresolved name is one the runner says can never apply here", () => {
    const repaired = {
      ...RETRIED_BUT_RESOLVED,
      unresolvedMigrations: ["039_native_decision_gates"],
      notApplicable: [{ name: "039_native_decision_gates", reason: "satisfied by 042_native_decision_gates_repair" }],
    };
    expect(previewMigrationsReady(repaired, 0)).toBe(true);
  });

  it("reports ready when an unresolved name is not a registered migration at all", () => {
    // An attempt row left behind by a migration that was since renamed or
    // removed. Nothing in the current manifest can ever finish it.
    expect(previewMigrationsReady({ ...RETRIED_BUT_RESOLVED, unresolvedMigrations: ["056_renamed_away"] }, 0)).toBe(true);
  });

  it("still refuses to report ready while a registered, applicable migration is stuck", () => {
    const stuck = { ...RETRIED_BUT_RESOLVED, unresolvedMigrations: ["039_native_decision_gates"] };
    expect(previewMigrationsReady(stuck, 0)).toBe(false);
    // And the same name blocks even when the status body claims nothing is
    // pending — the case where attempt rows and `pending` disagree, which is the
    // only reason this term exists on top of `pending`.
    expect(previewMigrationsReady({ ...stuck, pending: [] }, 0)).toBe(false);
  });

  it("still refuses to report ready while applicable migrations remain pending", () => {
    expect(previewMigrationsReady({ ...RETRIED_BUT_RESOLVED, pending: ["056_next"] }, 0)).toBe(false);
  });

  it("still refuses to report ready while an asynchronous index is not valid yet", () => {
    expect(previewMigrationsReady(RETRIED_BUT_RESOLVED, 1)).toBe(false);
  });

  // Fail loud rather than spending 180 attempts on a status shape that cannot
  // be read: an unreadable status is a defect, not a reason to wait.
  it.each([
    ["a missing unresolved list", { ...RETRIED_BUT_RESOLVED, unresolvedMigrations: undefined }],
    ["a non-array unresolved list", { ...RETRIED_BUT_RESOLVED, unresolvedMigrations: "none" }],
    ["a missing pending list", { ...RETRIED_BUT_RESOLVED, pending: undefined }],
    ["a missing manifest", { ...RETRIED_BUT_RESOLVED, manifest: undefined }],
    ["a missing notApplicable list", { ...RETRIED_BUT_RESOLVED, notApplicable: undefined }],
  ])("throws immediately on %s instead of waiting", (_case, status) => {
    expect(() => previewMigrationsReady(status, 0)).toThrow(/status/i);
  });

  it("throws rather than treating an unreadable index count as zero", () => {
    expect(() => previewMigrationsReady(RETRIED_BUT_RESOLVED, Number("not-a-number"))).toThrow(/index/i);
  });
});

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
