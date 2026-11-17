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

  function fakeDocument(tags: { content: string; setAttribute?: unknown }[]) {
    const withAttr = tags.map((t) => ({
      content: t.content,
      setAttribute(_: string, v: string) {
        this.content = v
      },
    }))
    return {
      tags: withAttr,
      querySelectorAll: () => withAttr,
      createElement: () => ({ name: "", content: "" }),
      head: { appendChild: vi.fn() },
    }
  }

  it("rewrites every theme-color tag, overriding the OS media pair", () => {
    const doc = fakeDocument([{ content: THEME_COLOR_LIGHT }, { content: THEME_COLOR_DARK }])
    vi.stubGlobal("document", doc)
    syncThemeColorMeta("dark")
    expect(doc.tags.map((t) => t.content)).toEqual([THEME_COLOR_DARK, THEME_COLOR_DARK])
    syncThemeColorMeta("light")
    expect(doc.tags.map((t) => t.content)).toEqual([THEME_COLOR_LIGHT, THEME_COLOR_LIGHT])
  })

  it("creates a tag when none exists", () => {
    const created = { name: "", content: "" }
    const doc = {
      querySelectorAll: () => [],
      createElement: () => created,
      head: { appendChild: vi.fn() },
    }
    vi.stubGlobal("document", doc)
    syncThemeColorMeta("dark")
    expect(created).toEqual({ name: "theme-color", content: THEME_COLOR_DARK })
    expect(doc.head.appendChild).toHaveBeenCalledWith(created)
  })

  it("init script sets the tag colour from a stored dark preference", () => {
    const tag = { content: THEME_COLOR_LIGHT, setAttribute(_: string, v: string) { this.content = v } }
    const root = { classList: { toggle: vi.fn() }, dataset: {} as Record<string, string>, style: {} as Record<string, string> }
    vi.stubGlobal("document", { documentElement: root, querySelectorAll: () => [tag] })
    vi.stubGlobal("localStorage", { getItem: () => "dark" })
    vi.stubGlobal("matchMedia", () => ({ matches: false }))
    new Function(workspaceThemeInitScript)()
    expect(tag.content).toBe(THEME_COLOR_DARK)
    expect(root.dataset.theme).toBe("dark")
  })
})
