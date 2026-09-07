import { describe, expect, it } from "vitest"

import {
  THEME_STORAGE_KEY,
  getResolvedTheme,
  isThemePreference,
} from "@/lib/theme"

describe("theme preferences", () => {
  it("accepts the supported persisted preferences only", () => {
    expect(isThemePreference("light")).toBe(true)
    expect(isThemePreference("dark")).toBe(true)
    expect(isThemePreference("system")).toBe(true)
    expect(isThemePreference("sepia")).toBe(false)
    expect(isThemePreference(null)).toBe(false)
  })

  it("resolves system preferences without changing explicit choices", () => {
    expect(getResolvedTheme("light", true)).toBe("light")
    expect(getResolvedTheme("dark", false)).toBe("dark")
    expect(getResolvedTheme("system", true)).toBe("dark")
    expect(getResolvedTheme("system", false)).toBe("light")
  })

  it("uses a stable namespaced storage key", () => {
    expect(THEME_STORAGE_KEY).toBe("compass-theme")
  })
})
