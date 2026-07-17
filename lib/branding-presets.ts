/**
 * Curated branding presets — palettes and font pairings a workspace can pick
 * from in Settings → Branding.
 *
 * Palette `primaryForegroundHex` values are precomputed here (not derived at
 * runtime) so preset selection is a deterministic, instant lookup — no
 * contrast math needed on the read path. Custom hex colors (not part of a
 * preset) still need a runtime contrast heuristic; see `pickForegroundHex`
 * in `lib/branding.ts`.
 */

export interface BrandPalette {
  id: string;
  label: string;
  /** Matches Tailwind's `--primary` / `--ring` token. */
  primaryHex: string;
  /** Matches Tailwind's `--primary-foreground` token. */
  primaryForegroundHex: string;
}

// "Default Indigo" is the exact sRGB conversion of the current
// `--primary: oklch(0.511 0.254 276.9)` token in app/globals.css, so picking
// it is a reversible no-op relative to today's production look.
export const PRESET_PALETTES: BrandPalette[] = [
  {
    id: "default-indigo",
    label: "Default Indigo",
    primaryHex: "#4f3df2",
    primaryForegroundHex: "#ffffff",
  },
  {
    id: "emerald",
    label: "Emerald",
    primaryHex: "#059669",
    primaryForegroundHex: "#ffffff",
  },
  {
    id: "rose",
    label: "Rose",
    primaryHex: "#e11d48",
    primaryForegroundHex: "#ffffff",
  },
  {
    id: "amber",
    label: "Amber",
    primaryHex: "#f59e0b",
    primaryForegroundHex: "#1e293b",
  },
  {
    id: "sky",
    label: "Sky Blue",
    primaryHex: "#0284c7",
    primaryForegroundHex: "#ffffff",
  },
  {
    id: "slate",
    label: "Slate",
    primaryHex: "#334155",
    primaryForegroundHex: "#ffffff",
  },
];

export function getPresetPalette(id: string): BrandPalette | undefined {
  return PRESET_PALETTES.find((p) => p.id === id);
}

export interface FontPreset {
  id: string;
  label: string;
  /** CSS variable defined by the matching next/font/google import in app/layout.tsx. */
  cssVariable: string;
  /** Fallback font stack used for live preview and as the CSS fallback chain. */
  previewFallback: string;
}

// "Jakarta Sans" matches the current default (Plus_Jakarta_Sans, already
// loaded in app/layout.tsx as --font-jakarta) so picking it is a no-op.
export const PRESET_FONTS: FontPreset[] = [
  {
    id: "jakarta",
    label: "Jakarta Sans",
    cssVariable: "--font-jakarta",
    previewFallback: "'Plus Jakarta Sans', sans-serif",
  },
  {
    id: "inter",
    label: "Inter",
    cssVariable: "--font-inter",
    previewFallback: "Inter, sans-serif",
  },
  {
    id: "poppins",
    label: "Poppins",
    cssVariable: "--font-poppins",
    previewFallback: "Poppins, sans-serif",
  },
  {
    id: "space-grotesk",
    label: "Space Grotesk",
    cssVariable: "--font-space-grotesk",
    previewFallback: "'Space Grotesk', sans-serif",
  },
  {
    id: "source-serif",
    label: "Source Serif 4",
    cssVariable: "--font-source-serif",
    previewFallback: "'Source Serif 4', serif",
  },
];

export function getPresetFont(id: string): FontPreset | undefined {
  return PRESET_FONTS.find((f) => f.id === id);
}
