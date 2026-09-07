// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ThemeProvider } from "@/components/theme/theme-provider"
import { ThemePreferenceControl } from "@/components/theme/theme-preference-control"

const matchMedia = vi.fn().mockReturnValue({
  matches: false,
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
})

const storage = new Map<string, string>()
const localStorageMock = {
  clear: () => storage.clear(),
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
  removeItem: (key: string) => storage.delete(key),
  key: (index: number) => [...storage.keys()][index] ?? null,
  get length() { return storage.size },
}

describe("ThemePreferenceControl", () => {
  beforeEach(() => {
    storage.clear()
    document.documentElement.classList.remove("dark")
    document.documentElement.removeAttribute("data-theme")
    Object.defineProperty(window, "matchMedia", { configurable: true, value: matchMedia })
    Object.defineProperty(window, "localStorage", { configurable: true, value: localStorageMock })
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: localStorageMock })
  })

  afterEach(cleanup)

  it("persists a dark choice and applies it to the document", () => {
    render(
      <ThemeProvider>
        <ThemePreferenceControl />
      </ThemeProvider>
    )

    fireEvent.click(screen.getByRole("button", { name: "Dark" }))

    expect(localStorage.getItem("compass-theme")).toBe("dark")
    expect(document.documentElement).toHaveClass("dark")
    expect(document.documentElement).toHaveAttribute("data-theme", "dark")
    expect(screen.getByRole("button", { name: "Dark" })).toHaveAttribute("aria-pressed", "true")
  })
})
