/**
 * Drift guard for the sandbox dependency set.
 *
 * The in-app agent boots each turn from a "golden" Vercel Sandbox snapshot with
 * SANDBOX_DEPENDENCIES pre-installed. When those deps change, the live snapshot
 * becomes STALE and must be rebuilt, or agent turns will run against outdated
 * dependencies.
 *
 * This test pins the expected deps fingerprint. If you changed
 * SANDBOX_DEPENDENCIES in lib/agent-sandbox.ts, this test fails on purpose —
 * update EXPECTED_DEPS_FINGERPRINT below, AND after the change deploys, rebuild
 * the golden snapshot so production picks up the new deps:
 *
 *   curl -X POST https://compass.rbcodelabs.com/api/admin/rebuild-agent-snapshot \
 *     -H "x-migration-secret: $MIGRATION_SECRET"
 *
 * (verify with GET on the same endpoint — `stale` should become false).
 */
import { describe, it, expect } from "vitest"
import { computeDepsFingerprint } from "@/lib/agent-sandbox"

const EXPECTED_DEPS_FINGERPRINT =
  "9354174ad461f97ace1d8922c68b290d05d6701cb790306b0a511bc91fbb6421"

describe("sandbox deps fingerprint drift guard", () => {
  it("matches the pinned fingerprint (update + rebuild the snapshot if this fails)", () => {
    expect(computeDepsFingerprint()).toBe(EXPECTED_DEPS_FINGERPRINT)
  })
})
