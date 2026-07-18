import { describe, it, expect } from "vitest";
import { resolveWorkspaceBranding, pickForegroundHex } from "@/lib/branding";
import { PRESET_PALETTES, PRESET_FONTS, getPresetPalette, getPresetFont } from "@/lib/branding-presets";

describe("resolveWorkspaceBranding", () => {
  it("returns null when no branding fields are set (all-null case)", () => {
    const result = resolveWorkspaceBranding({
      brandingPaletteId: null,
      brandingPrimaryHex: null,
      brandingFontPresetId: null,
      brandingFontFamily: null,
      brandingLogoUrl: null,
    });
    expect(result).toBeNull();
  });

  it("returns null when all fields are undefined", () => {
    expect(resolveWorkspaceBranding({})).toBeNull();
  });

  it("resolves a preset palette to its hex + foreground hex", () => {
    const emerald = getPresetPalette("emerald")!;
    const result = resolveWorkspaceBranding({
      brandingPaletteId: "emerald",
      brandingPrimaryHex: null,
      brandingFontPresetId: null,
      brandingFontFamily: null,
      brandingLogoUrl: null,
    });
    expect(result).not.toBeNull();
    expect(result!.primaryHex).toBe(emerald.primaryHex);
    expect(result!.primaryForegroundHex).toBe(emerald.primaryForegroundHex);
    expect(result!.fontCssValue).toBeNull();
  });

  it("ignores an unknown paletteId (resolves to no color override)", () => {
    const result = resolveWorkspaceBranding({
      brandingPaletteId: "not-a-real-palette",
      brandingPrimaryHex: null,
    });
    expect(result).toBeNull();
  });

  it("custom hex overrides a palette id when both are set", () => {
    const result = resolveWorkspaceBranding({
      brandingPaletteId: "emerald",
      brandingPrimaryHex: "#123456",
    });
    expect(result!.primaryHex).toBe("#123456");
    // Not the emerald preset's precomputed foreground — computed via the
    // contrast heuristic instead, since custom hex bypasses preset lookup.
    expect(result!.primaryForegroundHex).toBe(pickForegroundHex("#123456"));
  });

  it("ignores a malformed custom hex and falls back to the palette", () => {
    const result = resolveWorkspaceBranding({
      brandingPaletteId: "rose",
      brandingPrimaryHex: "not-a-hex",
    });
    const rose = getPresetPalette("rose")!;
    expect(result!.primaryHex).toBe(rose.primaryHex);
  });

  it("resolves a preset font to its CSS variable + fallback stack", () => {
    const inter = getPresetFont("inter")!;
    const result = resolveWorkspaceBranding({
      brandingFontPresetId: "inter",
    });
    expect(result!.fontCssValue).toBe(`var(${inter.cssVariable}), ${inter.previewFallback}`);
    expect(result!.customFontLink).toBeNull();
  });

  it("resolves a custom font family to a quoted CSS value and a Google Fonts link", () => {
    const result = resolveWorkspaceBranding({
      brandingFontFamily: "Roboto Slab",
    });
    expect(result!.fontCssValue).toBe(`"Roboto Slab", sans-serif`);
    expect(result!.customFontLink).not.toBeNull();
    expect(result!.customFontLink!.family).toBe("Roboto Slab");
    // Google's CSS2 API expects spaces as literal '+'
    expect(result!.customFontLink!.href).toBe(
      "https://fonts.googleapis.com/css2?family=Roboto+Slab&display=swap"
    );
  });

  it("custom font family overrides a font preset id when both are set", () => {
    const result = resolveWorkspaceBranding({
      brandingFontPresetId: "poppins",
      brandingFontFamily: "Custom Sans",
    });
    expect(result!.fontCssValue).toBe(`"Custom Sans", sans-serif`);
    expect(result!.customFontLink!.family).toBe("Custom Sans");
  });

  it("resolves a logo URL independently of color/font branding", () => {
    const result = resolveWorkspaceBranding({
      brandingLogoUrl: "https://blob.example.com/logo.png",
    });
    expect(result).not.toBeNull();
    expect(result!.logoUrl).toBe("https://blob.example.com/logo.png");
    expect(result!.primaryHex).toBeNull();
    expect(result!.fontCssValue).toBeNull();
  });

  it("resolves color, font, and logo together", () => {
    const result = resolveWorkspaceBranding({
      brandingPrimaryHex: "#abcdef",
      brandingFontFamily: "My Font",
      brandingLogoUrl: "https://blob.example.com/logo.png",
    });
    expect(result!.primaryHex).toBe("#abcdef");
    expect(result!.fontCssValue).toBe(`"My Font", sans-serif`);
    expect(result!.logoUrl).toBe("https://blob.example.com/logo.png");
  });
});

describe("pickForegroundHex (contrast heuristic)", () => {
  it("picks dark text for a light/bright color", () => {
    expect(pickForegroundHex("#ffffff")).toBe("#1e293b");
    expect(pickForegroundHex("#fef3c7")).toBe("#1e293b"); // pale amber
  });

  it("picks white text for a dark/saturated color", () => {
    expect(pickForegroundHex("#000000")).toBe("#ffffff");
    expect(pickForegroundHex("#4f3df2")).toBe("#ffffff"); // default indigo
    expect(pickForegroundHex("#059669")).toBe("#ffffff"); // emerald
  });
});

describe("branding-presets sanity", () => {
  it("every preset palette resolves via getPresetPalette", () => {
    for (const p of PRESET_PALETTES) {
      expect(getPresetPalette(p.id)).toEqual(p);
    }
  });

  it("every preset font resolves via getPresetFont", () => {
    for (const f of PRESET_FONTS) {
      expect(getPresetFont(f.id)).toEqual(f);
    }
  });

  it("returns undefined for an unknown id", () => {
    expect(getPresetPalette("nope")).toBeUndefined();
    expect(getPresetFont("nope")).toBeUndefined();
  });
});
