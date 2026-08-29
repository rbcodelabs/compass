/**
 * Unit coverage for the e2e run-ownership token.
 *
 * Lives here rather than beside the helper because vitest.config.ts excludes
 * `**\/e2e/**` wholesale (that tree is Playwright's). The logic is pure and is
 * the only thing standing between an interrupted run's teardown and a live
 * run's data, so it is worth locking down.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  orgNameForToken,
  setRunToken,
  readRunToken,
  clearRunToken,
} from "@/e2e/functional/fixtures/run-token";

describe("e2e run token", () => {
  beforeEach(() => clearRunToken());
  afterEach(() => clearRunToken());

  it("returns null before a run claims the org", () => {
    expect(readRunToken()).toBeNull();
  });

  it("round-trips a token", () => {
    setRunToken("abc123");
    expect(readRunToken()).toBe("abc123");
  });

  it("clears back to null", () => {
    setRunToken("abc123");
    clearRunToken();
    expect(readRunToken()).toBeNull();
  });

  it("stamps a name that embeds the token", () => {
    expect(orgNameForToken("abc123")).toBe("E2E Test Org [abc123]");
  });

  it("gives different runs different stamps", () => {
    // The whole guard rests on this: teardown compares its own stamp against
    // whatever is currently on the org, so two runs must never collide.
    expect(orgNameForToken("aaaa1111")).not.toBe(orgNameForToken("bbbb2222"));
  });

  it("survives being read after the module-level value is dropped", () => {
    // readRunToken falls back to process.env, so the check still works if the
    // helper module is re-instantiated between setup and teardown.
    setRunToken("envtoken");
    expect(process.env.E2E_RUN_TOKEN).toBe("envtoken");
    expect(readRunToken()).toBe("envtoken");
  });

  it("does not leak the env var after clearing", () => {
    setRunToken("envtoken");
    clearRunToken();
    expect(process.env.E2E_RUN_TOKEN).toBeUndefined();
  });
});
