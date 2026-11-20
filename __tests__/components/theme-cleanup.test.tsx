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

it.each(["light", "dark"] as const)(
  "keeps one framework tag per mode when leaving a workspace with a %s override",
  (preference) => {
    const modes = [["light", THEME_COLOR_LIGHT], ["dark", THEME_COLOR_DARK]]
    for (const [scheme, color] of modes) {
      document.head.insertAdjacentHTML("beforeend", `<meta name="theme-color" media="(prefers-color-scheme: ${scheme})" content="${color}">`)
    }
    vi.stubGlobal("localStorage", { getItem: () => preference })
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })))

    const view = render(<ThemeProvider><div>Workspace</div></ThemeProvider>)
    const tags = () => Array.from(document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'))

    // Model destination metadata arriving in the same document before passive
    // cleanup. React's hoistable-meta lookup requires the expected content.
    for (const [scheme, color] of modes) {
      const media = `(prefers-color-scheme: ${scheme})`
      if (!tags().some((tag) => tag.getAttribute("media") === media && tag.content === color)) {
        document.head.insertAdjacentHTML("beforeend", `<meta name="theme-color" media="${media}" content="${color}">`)
      }
    }
    view.unmount()

    for (const [scheme, color] of modes) {
      expect(tags().filter((tag) => tag.getAttribute("media") === `(prefers-color-scheme: ${scheme})`).map((tag) => tag.content)).toEqual([color])
    }
    expect(tags()).toHaveLength(2)
  }
)
