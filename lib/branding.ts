/**
 * Pure resolution logic for workspace branding (colors + fonts).
 *
 * Precedence rules:
 *  - Custom hex color wins over a preset palette id.
 *  - Custom font family wins over a preset font id.
 *  - All-null (no branding fields set) resolves to `null`, which callers
 *    must render as "no override" — today's default look, byte-identical
 *    to production before this feature existed.
 */
import { getPresetPalette, getPresetFont } from "./branding-presets";

export interface WorkspaceBrandingFields {
  brandingPaletteId?: string | null;
  brandingPrimaryHex?: string | null;
  brandingFontPresetId?: string | null;
  brandingFontFamily?: string | null;
  brandingLogoUrl?: string | null;
}

export interface ResolvedBranding {
  /** Hex for --primary / --ring, or null when no color branding resolved. */
  primaryHex: string | null;
  /** Hex for --primary-foreground. Non-null whenever primaryHex is non-null. */
  primaryForegroundHex: string | null;
  /** CSS value for --font-sans, or null when no font branding resolved. */
  fontCssValue: string | null;
  /** Set only for a custom (non-preset) font family — the <link> tags needed to load it. */
  customFontLink: { family: string; href: string } | null;
  /** Uploaded logo URL, or null. */
  logoUrl: string | null;
}

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

/**
 * Relative-luminance contrast heuristic (WCAG 2.x formula): picks a
 * near-black or white foreground depending on how light the given hex is.
 * Only used for CUSTOM hex colors — preset palettes ship a precomputed
 * `primaryForegroundHex` instead (see lib/branding-presets.ts), since that's
 * cheaper and lets us hand-tune presets that sit near the threshold (e.g.
 * Amber).
 */
export function pickForegroundHex(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const luminance = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  // Threshold picked so mid-brightness saturated colors (most brand colors)
  // still get white text; only genuinely light/bright hexes flip to dark text.
  return luminance > 0.35 ? "#1e293b" : "#ffffff";
}

/**
 * Builds a Google Fonts CSS2 stylesheet URL for a font family name.
 * Google's API expects spaces encoded as literal `+`, not `%20` — so this
 * percent-encodes everything else (safely handling apostrophes etc.) and
 * then swaps `%20` back to `+`.
 */
function googleFontsHref(family: string): string {
  const encoded = encodeURIComponent(family).replace(/%20/g, "+");
  return `https://fonts.googleapis.com/css2?family=${encoded}&display=swap`;
}

export function resolveWorkspaceBranding(
  workspace: WorkspaceBrandingFields
): ResolvedBranding | null {
  // ── Color: custom hex wins over palette id ──────────────────────────────
  let primaryHex: string | null = null;
  let primaryForegroundHex: string | null = null;
  if (workspace.brandingPrimaryHex && HEX_RE.test(workspace.brandingPrimaryHex)) {
    primaryHex = workspace.brandingPrimaryHex;
    primaryForegroundHex = pickForegroundHex(primaryHex);
  } else if (workspace.brandingPaletteId) {
    const palette = getPresetPalette(workspace.brandingPaletteId);
    if (palette) {
      primaryHex = palette.primaryHex;
      primaryForegroundHex = palette.primaryForegroundHex;
    }
  }

  // ── Font: custom family wins over preset id ─────────────────────────────
  let fontCssValue: string | null = null;
  let customFontLink: { family: string; href: string } | null = null;
  if (workspace.brandingFontFamily) {
    const family = workspace.brandingFontFamily;
    fontCssValue = `"${family}", sans-serif`;
    customFontLink = { family, href: googleFontsHref(family) };
  } else if (workspace.brandingFontPresetId) {
    const preset = getPresetFont(workspace.brandingFontPresetId);
    if (preset) {
      fontCssValue = `var(${preset.cssVariable}), ${preset.previewFallback}`;
    }
  }

  const logoUrl = workspace.brandingLogoUrl ?? null;

  if (primaryHex === null && fontCssValue === null && logoUrl === null) {
    return null;
  }

  return { primaryHex, primaryForegroundHex, fontCssValue, customFontLink, logoUrl };
}
