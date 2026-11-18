// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"

import { ThemeProvider } from "@/components/theme/theme-provider"
import { THEME_COLOR_DARK, THEME_COLOR_LIGHT } from "@/lib/theme"

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  document.head.innerHTML = ""
})

it("restores OS-specific theme colors after leaving the workspace", () => {
  document.head.innerHTML = `<meta name="theme-color" media="(prefers-color-scheme: light)" content="${THEME_COLOR_LIGHT}"><meta name="theme-color" media="(prefers-color-scheme: dark)" content="${THEME_COLOR_DARK}">`
  vi.stubGlobal("localStorage", { getItem: () => "dark" })
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })))

  const view = render(<ThemeProvider><div>Workspace</div></ThemeProvider>)
  const colors = () => Array.from(document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'), (tag) => tag.content)
  expect(colors()).toEqual([THEME_COLOR_DARK, THEME_COLOR_DARK])

  view.unmount()
  expect(colors()).toEqual([THEME_COLOR_LIGHT, THEME_COLOR_DARK])
})

it.each(["no theme color", "an unqualified theme color"])(
  "restores OS-following theme colors after leaving a workspace with %s",
  (initial) => {
    document.head.innerHTML = initial === "an unqualified theme color"
      ? '<meta name="theme-color" content="#ffffff">'
      : ""
    vi.stubGlobal("localStorage", { getItem: () => "dark" })
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })))

    const view = render(<ThemeProvider><div>Workspace</div></ThemeProvider>)
    view.unmount()

    const tags = Array.from(document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'))
    expect(tags.map((tag) => [tag.getAttribute("media"), tag.content])).toEqual([
      ["(prefers-color-scheme: light)", THEME_COLOR_LIGHT],
      ["(prefers-color-scheme: dark)", THEME_COLOR_DARK],
    ])
  }
)
