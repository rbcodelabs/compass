"use client"

import * as React from "react"

import {
  THEME_STORAGE_KEY,
  THEME_COLOR_LIGHT,
  THEME_COLOR_DARK,
  getResolvedTheme,
  syncThemeColorMeta,
  isThemePreference,
  type ThemePreference,
} from "@/lib/theme"

type ThemeContextValue = {
  preference: ThemePreference
  setPreference: (preference: ThemePreference) => void
}

const ThemeContext = React.createContext<ThemeContextValue | null>(null)

function applyTheme(preference: ThemePreference) {
  const resolved = getResolvedTheme(
    preference,
    window.matchMedia("(prefers-color-scheme: dark)").matches
  )
  document.documentElement.classList.toggle("dark", resolved === "dark")
  document.documentElement.dataset.theme = resolved
  document.documentElement.style.colorScheme = resolved
  syncThemeColorMeta(resolved)
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [preference, setPreferenceState] = React.useState<ThemePreference>("system")

  React.useEffect(() => {
    const stored = localStorage.getItem(THEME_STORAGE_KEY)
    const initialPreference = isThemePreference(stored) ? stored : "system"
    setPreferenceState(initialPreference)
    applyTheme(initialPreference)
    return () => {
      document.documentElement.classList.remove("dark")
      document.documentElement.removeAttribute("data-theme")
      document.documentElement.style.removeProperty("color-scheme")
      // Leaving the workspace shell: title bar goes back to following the OS.
      document.querySelectorAll('meta[name="theme-color"]:not([media]), meta[name="theme-color"][media=""]')
        .forEach((tag) => tag.remove())
      for (const [scheme, color] of [["light", THEME_COLOR_LIGHT], ["dark", THEME_COLOR_DARK]]) {
        const media = `(prefers-color-scheme: ${scheme})`
        const tags = document.querySelectorAll<HTMLMetaElement>(`meta[name="theme-color"][media="${media}"]`)
        if (tags.length === 0) {
          const tag = document.createElement("meta")
          tag.name = "theme-color"
          tag.setAttribute("media", media)
          tag.content = color
          document.head.appendChild(tag)
        } else {
          tags.forEach((tag) => { tag.content = color })
        }
      }
    }
  }, [])

  React.useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)")
    const handleChange = () => {
      if (preference === "system") applyTheme("system")
    }
    media.addEventListener("change", handleChange)
    return () => media.removeEventListener("change", handleChange)
  }, [preference])

  const setPreference = React.useCallback((nextPreference: ThemePreference) => {
    localStorage.setItem(THEME_STORAGE_KEY, nextPreference)
    setPreferenceState(nextPreference)
    applyTheme(nextPreference)
  }, [])

  return (
    <ThemeContext.Provider value={{ preference, setPreference }}>
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme() {
  const context = React.useContext(ThemeContext)
  if (!context) throw new Error("useTheme must be used within ThemeProvider")
  return context
}
