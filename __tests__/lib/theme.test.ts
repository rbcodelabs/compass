// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  THEME_COLOR_DARK,
  THEME_COLOR_LIGHT,
  THEME_STORAGE_KEY,
  syncThemeColorMeta,
  workspaceThemeInitScript,
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

describe("title bar theme-color sync", () => {
  afterEach(() => vi.unstubAllGlobals())

  afterEach(() => {
    document.head.innerHTML = ""
    document.documentElement.classList.remove("dark")
    document.documentElement.removeAttribute("data-theme")
    document.documentElement.style.removeProperty("color-scheme")
  })

  it("keeps a single leading workspace override without changing Next metadata", () => {
    document.head.innerHTML = `<meta name="theme-color" media="(prefers-color-scheme: light)" content="${THEME_COLOR_LIGHT}"><meta name="theme-color" media="(prefers-color-scheme: dark)" content="${THEME_COLOR_DARK}">`
    syncThemeColorMeta("dark")
    const tags = () => Array.from(document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'))
    expect(tags().map((tag) => tag.content)).toEqual(["rgb(27, 26, 24)", THEME_COLOR_LIGHT, THEME_COLOR_DARK])
    syncThemeColorMeta("light")
    expect(tags().map((tag) => tag.content)).toEqual(["rgb(244, 242, 237)", THEME_COLOR_LIGHT, THEME_COLOR_DARK])
  })

  it("init script sets the workspace override before hydration", () => {
    vi.stubGlobal("localStorage", { getItem: () => "dark" })
    vi.stubGlobal("matchMedia", () => ({ matches: false }))
    new Function(workspaceThemeInitScript)()
    expect(document.head.firstElementChild?.getAttribute("content")).toBe("rgb(27, 26, 24)")
    expect(document.documentElement.dataset.theme).toBe("dark")
  })
})
