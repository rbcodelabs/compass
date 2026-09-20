import { afterEach, beforeEach, expect, it } from "vitest"
import { vi } from "vitest"
import { passkeysEnabled } from "@/lib/passkeys"

beforeEach(() => vi.unstubAllEnvs())
afterEach(() => vi.unstubAllEnvs())

it("is disabled when COMPASS_PASSKEYS_ENABLED is unset", () => {
  expect(passkeysEnabled()).toBe(false)
})

it("is disabled for any value other than the exact string \"1\"", () => {
  vi.stubEnv("COMPASS_PASSKEYS_ENABLED", "true")
  expect(passkeysEnabled()).toBe(false)
  vi.stubEnv("COMPASS_PASSKEYS_ENABLED", "0")
  expect(passkeysEnabled()).toBe(false)
})

it("is enabled when COMPASS_PASSKEYS_ENABLED is exactly \"1\"", () => {
  vi.stubEnv("COMPASS_PASSKEYS_ENABLED", "1")
  expect(passkeysEnabled()).toBe(true)
})
