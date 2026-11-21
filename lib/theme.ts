export const THEME_STORAGE_KEY = "compass-theme"

export const themePreferences = ["light", "dark", "system"] as const

export type ThemePreference = (typeof themePreferences)[number]
export type ResolvedTheme = Exclude<ThemePreference, "system">

export function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === "string" && themePreferences.includes(value as ThemePreference)
}

export function getResolvedTheme(
  preference: ThemePreference,
  systemPrefersDark: boolean
): ResolvedTheme {
  return preference === "system" ? (systemPrefersDark ? "dark" : "light") : preference
}

export const THEME_COLOR_LIGHT = "#F4F2ED"
export const THEME_COLOR_DARK = "#1B1A18"

const OVERRIDE_SELECTOR = 'meta[name="theme-color"][data-workspace-theme-color]'
const OVERRIDE_LIGHT = "rgb(244, 242, 237)"
const OVERRIDE_DARK = "rgb(27, 26, 24)"

export function syncThemeColorMeta(resolved: ResolvedTheme) {
  let tag = document.querySelector<HTMLMetaElement>(OVERRIDE_SELECTOR)
  if (!tag) {
    tag = document.createElement("meta")
    tag.name = "theme-color"
    tag.setAttribute("data-workspace-theme-color", "")
    document.head.prepend(tag)
  }
  // The browser uses the first matching tag. A distinct color serialization
  // keeps React from adopting this tag when it matches metadata by content.
  tag.content = resolved === "dark" ? OVERRIDE_DARK : OVERRIDE_LIGHT
}

export function clearThemeColorMeta() {
  document.querySelector(OVERRIDE_SELECTOR)?.remove()
}

export const workspaceThemeInitScript = `(() => {
  try {
    const stored = localStorage.getItem('${THEME_STORAGE_KEY}');
    const preference = stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'system';
    const resolved = preference === 'system' && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : preference === 'dark' ? 'dark' : 'light';
    document.documentElement.classList.toggle('dark', resolved === 'dark');
    document.documentElement.dataset.theme = resolved;
    document.documentElement.style.colorScheme = resolved;
    let tag = document.querySelector('${OVERRIDE_SELECTOR}');
    if (!tag) {
      tag = document.createElement('meta');
      tag.name = 'theme-color';
      tag.setAttribute('data-workspace-theme-color', '');
      document.head.prepend(tag);
    }
    tag.content = resolved === 'dark' ? '${OVERRIDE_DARK}' : '${OVERRIDE_LIGHT}';
  } catch {}
})();`
