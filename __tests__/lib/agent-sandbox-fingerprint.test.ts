/**
 * Drift guard for the sandbox snapshot recipe.
 *
 * The in-app agent boots each turn from a "golden" Vercel Sandbox snapshot with
 * the recipe pre-installed. When the recipe changes, the live snapshot becomes
 * STALE and must be rebuilt, or agent turns will run against outdated contents.
 *
 * The recipe is wider than the dependency list: it covers SANDBOX_DEPENDENCIES,
 * SANDBOX_SYSTEM_PACKAGES (the libraries headless Chromium needs) and the
 * runtime. A change to any of them is equally stale-making — dropping a system
 * library from a live snapshot breaks the browser just as thoroughly as
 * downgrading playwright-core would.
 *
 * This test pins the expected fingerprint. If you changed any of those inputs in
 * lib/agent-sandbox.ts, this test fails on purpose — update
 * EXPECTED_DEPS_FINGERPRINT below, AND after the change deploys, rebuild the
 * golden snapshot so production picks up the new contents:
 *
 *   curl -X POST https://compass.rbcodelabs.com/api/admin/rebuild-agent-snapshot \
 *     -H "x-migration-secret: $MIGRATION_SECRET"
 *
 * (verify with GET on the same endpoint — `stale` should become false).
 */
import { describe, it, expect } from "vitest"
import {
  computeDepsFingerprint,
  SANDBOX_DEPENDENCIES,
  SANDBOX_SYSTEM_PACKAGES,
} from "@/lib/agent-sandbox"

const EXPECTED_DEPS_FINGERPRINT =
  "b8fda7838b294a6c98988b1526ff50715923b923c403f2c0db9b9f13e4169018"

describe("sandbox deps fingerprint drift guard", () => {
  it("matches the pinned fingerprint (update + rebuild the snapshot if this fails)", () => {
    expect(computeDepsFingerprint()).toBe(EXPECTED_DEPS_FINGERPRINT)
  })

  it("actually covers the system package list, not just package.json", () => {
    // The fingerprint used to hash package.json alone. Chromium's system
    // libraries are installed by the build but declared nowhere npm can see, so
    // without this coverage a dropped library would ship to a live snapshot that
    // still reported itself fresh. Mutate the real exported list and observe the
    // real function move — comparing two locally-built hashes would prove
    // nothing, since any two different strings hash differently.
    const baseline = computeDepsFingerprint()
    const packages = SANDBOX_SYSTEM_PACKAGES as string[]
    packages.push("libdrm")
    try {
      expect(computeDepsFingerprint()).not.toBe(baseline)
    } finally {
      packages.pop()
    }
    expect(computeDepsFingerprint()).toBe(baseline)
  })

  it("pins the browser payload and driver to the same exact version", () => {
    // playwright-core must not float relative to the browser build it drives:
    // a caret on either one reintroduces the version skew that makes the baked
    // Chromium unfindable at runtime.
    const browser = SANDBOX_DEPENDENCIES["@playwright/browser-chromium"]
    const driver = SANDBOX_DEPENDENCIES["playwright-core"]
    expect(browser).toMatch(/^\d+\.\d+\.\d+$/)
    expect(driver).toBe(browser)
  })
})
