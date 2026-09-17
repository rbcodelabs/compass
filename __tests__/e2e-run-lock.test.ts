/**
 * Regression test for scripts/e2e-run-lock.mjs.
 *
 * The functional E2E run lock exists specifically to make two *different*
 * git worktrees serialize against each other when they target the same
 * local `compass_e2e` database — that's exactly the collision observed on
 * 2026-09-17 (one agent session running the suite from inside another
 * session's worktree). playwright.config.ts's `FUNCTIONAL_PORT` is
 * deliberately derived from `process.cwd()` so *different* worktrees get
 * *different* dev-server ports and can run concurrently without a port
 * clash. If someone "fixes" the run lock the same way — deriving its key
 * from cwd for consistency with that pattern — the lock would silently stop
 * doing its job: two worktrees would each take out a *different* advisory
 * lock and never block each other, while looking exactly as correct as the
 * real fix. This test exists to catch that regression, not to test Postgres
 * itself.
 */
import { describe, expect, it } from "vitest";
import { E2E_RUN_LOCK_KEY } from "../scripts/e2e-run-lock.mjs";

describe("e2e-run-lock", () => {
  it("uses a fixed lock key, not one derived from the working directory", () => {
    // A cwd-derived key (e.g. hashing process.cwd(), the way
    // playwright.config.ts's FUNCTIONAL_PORT does on purpose) would produce
    // a different value depending on where this test file happens to be
    // checked out. Assert the exact known constant so any change to the
    // derivation — cwd-based or otherwise — fails this test loudly instead
    // of only failing a live two-worktree run days later.
    expect(E2E_RUN_LOCK_KEY).toBe(BigInt("6820147301918223"));
  });

  it("is representable as a Postgres bigint (fits in a signed 64-bit range)", () => {
    // pg_advisory_lock(bigint) requires a value in [-2^63, 2^63 - 1].
    // A key that overflows this would fail at the first real acquire call
    // rather than at review time.
    const min = BigInt(-1) * BigInt(2) ** BigInt(63);
    const max = BigInt(2) ** BigInt(63) - BigInt(1);
    expect(E2E_RUN_LOCK_KEY >= min && E2E_RUN_LOCK_KEY <= max).toBe(true);
  });
});
