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

// Title bar / status bar colours (PWA window chrome, mobile browsers). Must
// match --surface-navigation in globals.css and the viewport themeColor pair in
// app/layout.tsx. The static tags there follow the OS setting only, so when the
// in-app preference overrides it we rewrite every theme-color tag to the
// resolved value.
export const THEME_COLOR_LIGHT = "#F4F2ED"
export const THEME_COLOR_DARK = "#1B1A18"

export function syncThemeColorMeta(resolved: ResolvedTheme) {
  const color = resolved === "dark" ? THEME_COLOR_DARK : THEME_COLOR_LIGHT
  const tags = document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')
  if (tags.length === 0) {
    const meta = document.createElement("meta")
    meta.name = "theme-color"
    document.head.appendChild(meta)
    meta.content = color
    return
  }
  tags.forEach((tag) => {
    tag.content = color
  })
}

export const workspaceThemeInitScript = `(() => {
  try {
    const stored = localStorage.getItem('${THEME_STORAGE_KEY}');
    const preference = stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'system';
    const resolved = preference === 'system' && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : preference === 'dark' ? 'dark' : 'light';
    document.documentElement.classList.toggle('dark', resolved === 'dark');
    document.documentElement.dataset.theme = resolved;
    document.documentElement.style.colorScheme = resolved;
    const color = resolved === 'dark' ? '${THEME_COLOR_DARK}' : '${THEME_COLOR_LIGHT}';
    document.querySelectorAll('meta[name="theme-color"]').forEach((t) => { t.setAttribute('content', color); });
  } catch {}
})();`
