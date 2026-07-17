"use client";

import { useState, useTransition, useRef } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { updateWorkspaceBranding } from "@/app/[orgSlug]/[workspaceSlug]/settings/actions";
import { PRESET_PALETTES, PRESET_FONTS } from "@/lib/branding-presets";

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

interface Props {
  orgSlug: string;
  workspaceSlug: string;
  initialPaletteId: string | null;
  initialPrimaryHex: string | null;
  initialFontPresetId: string | null;
  initialFontFamily: string | null;
  initialLogoUrl: string | null;
}

export function WorkspaceBrandingPanel({
  orgSlug,
  workspaceSlug,
  initialPaletteId,
  initialPrimaryHex,
  initialFontPresetId,
  initialFontFamily,
  initialLogoUrl,
}: Props) {
  // ── Color state ────────────────────────────────────────────────────────
  const [colorMode, setColorMode] = useState<"preset" | "custom">(
    initialPrimaryHex ? "custom" : "preset"
  );
  const [paletteId, setPaletteId] = useState(initialPaletteId ?? PRESET_PALETTES[0].id);
  const [hexInput, setHexInput] = useState(initialPrimaryHex ?? "#4f3df2");
  const [hexError, setHexError] = useState<string | null>(null);

  // ── Font state ─────────────────────────────────────────────────────────
  const [fontMode, setFontMode] = useState<"preset" | "custom">(
    initialFontFamily ? "custom" : "preset"
  );
  const [fontPresetId, setFontPresetId] = useState(initialFontPresetId ?? PRESET_FONTS[0].id);
  const [fontFamilyInput, setFontFamilyInput] = useState(initialFontFamily ?? "");

  // ── Logo state ─────────────────────────────────────────────────────────
  const [logoUrl, setLogoUrl] = useState(initialLogoUrl);
  const [logoError, setLogoError] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [isPending, startTransition] = useTransition();

  function save(overrides: {
    paletteId?: string | null;
    primaryHex?: string | null;
    fontPresetId?: string | null;
    fontFamily?: string | null;
    logoUrl?: string | null;
  }) {
    startTransition(async () => {
      await updateWorkspaceBranding(orgSlug, workspaceSlug, overrides);
    });
  }

  // ── Color handlers ────────────────────────────────────────────────────
  function handleSelectPalette(id: string) {
    setColorMode("preset");
    setPaletteId(id);
    save({ paletteId: id, primaryHex: null });
  }

  function handleSwitchToCustomColor() {
    // View-only toggle — do NOT auto-save here. hexInput may still hold a
    // stale value from an earlier custom-mode visit (or the initial
    // placeholder default) that the user hasn't actually confirmed by
    // typing; saving on mere toggle would silently overwrite a valid preset
    // selection. Only handleHexChange (an actual edit) persists a color.
    setColorMode("custom");
  }

  function handleSwitchToPresetColor() {
    setColorMode("preset");
    setHexError(null);
    save({ paletteId, primaryHex: null });
  }

  function handleHexChange(value: string) {
    setHexInput(value);
    if (!HEX_RE.test(value)) {
      setHexError("Enter a 6-digit hex color, e.g. #4f3df2");
      return;
    }
    setHexError(null);
    save({ primaryHex: value, paletteId: null });
  }

  // ── Font handlers ─────────────────────────────────────────────────────
  function handleSelectFontPreset(id: string) {
    setFontMode("preset");
    setFontPresetId(id);
    save({ fontPresetId: id, fontFamily: null });
  }

  function handleSwitchToCustomFont() {
    // View-only toggle — see handleSwitchToCustomColor for why this must not
    // auto-save a possibly-stale fontFamilyInput value.
    setFontMode("custom");
  }

  function handleSwitchToPresetFont() {
    setFontMode("preset");
    save({ fontPresetId, fontFamily: null });
  }

  function handleFontFamilyChange(value: string) {
    setFontFamilyInput(value);
    if (value.trim()) {
      save({ fontFamily: value.trim(), fontPresetId: null });
    }
  }

  // ── Logo handlers ──────────────────────────────────────────────────────
  async function handleFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setLogoError(null);

    if (!file.type.startsWith("image/")) {
      setLogoError("Please choose an image file");
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setLogoError("Image must be under 10MB");
      return;
    }

    setIsUploading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/branding/logo", { method: "POST", body: form });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Upload failed");
      }
      const { url } = (await res.json()) as { url: string };
      setLogoUrl(url);
      save({ logoUrl: url });
    } catch (err) {
      setLogoError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  function handleRemoveLogo() {
    setLogoUrl(null);
    setLogoError(null);
    save({ logoUrl: null });
  }

  return (
    <div className="flex flex-col gap-8">
      {/* ── Color ──────────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">Color</span>
          <div className="flex items-center rounded-lg border border-border p-0.5 ml-auto">
            <button
              type="button"
              onClick={handleSwitchToPresetColor}
              aria-label="Preset color"
              className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
                colorMode === "preset" ? "bg-primary text-primary-foreground" : "text-muted-foreground"
              }`}
            >
              Preset
            </button>
            <button
              type="button"
              onClick={handleSwitchToCustomColor}
              aria-label="Custom color"
              className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
                colorMode === "custom" ? "bg-primary text-primary-foreground" : "text-muted-foreground"
              }`}
            >
              Custom
            </button>
          </div>
        </div>

        {colorMode === "preset" && (
          <div className="flex items-center gap-3 flex-wrap">
            {PRESET_PALETTES.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => handleSelectPalette(p.id)}
                disabled={isPending}
                className="flex flex-col items-center gap-1.5"
                aria-label={`Select ${p.label} palette`}
              >
                <span
                  className="w-8 h-8 rounded-full ring-offset-2 ring-offset-background transition-transform hover:scale-110"
                  style={{
                    backgroundColor: p.primaryHex,
                    outline: paletteId === p.id ? `2px solid ${p.primaryHex}` : "none",
                    outlineOffset: "2px",
                  }}
                />
                <span className="text-[11px] text-muted-foreground">{p.label}</span>
              </button>
            ))}
          </div>
        )}

        {colorMode === "custom" && (
          <div className="flex items-center gap-3">
            <input
              type="color"
              value={HEX_RE.test(hexInput) ? hexInput : "#4f3df2"}
              onChange={(e) => handleHexChange(e.target.value)}
              className="w-9 h-9 rounded-lg border border-border cursor-pointer p-0.5 bg-transparent"
              aria-label="Custom color swatch"
            />
            <div className="flex flex-col gap-1">
              <Input
                value={hexInput}
                onChange={(e) => handleHexChange(e.target.value)}
                placeholder="#4f3df2"
                aria-label="Custom hex color"
                className="w-32 font-mono"
                aria-invalid={!!hexError}
              />
              {hexError && <span className="text-xs text-destructive">{hexError}</span>}
            </div>
          </div>
        )}
      </div>

      {/* ── Font ───────────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">Font</span>
          <div className="flex items-center rounded-lg border border-border p-0.5 ml-auto">
            <button
              type="button"
              onClick={handleSwitchToPresetFont}
              aria-label="Preset font"
              className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
                fontMode === "preset" ? "bg-primary text-primary-foreground" : "text-muted-foreground"
              }`}
            >
              Preset
            </button>
            <button
              type="button"
              onClick={handleSwitchToCustomFont}
              aria-label="Custom font"
              className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
                fontMode === "custom" ? "bg-primary text-primary-foreground" : "text-muted-foreground"
              }`}
            >
              Custom
            </button>
          </div>
        </div>

        {fontMode === "preset" && (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {PRESET_FONTS.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => handleSelectFontPreset(f.id)}
                disabled={isPending}
                className={`rounded-lg border px-3 py-2.5 text-left transition-colors ${
                  fontPresetId === f.id
                    ? "border-primary ring-1 ring-primary bg-primary/5"
                    : "border-border hover:border-primary/40"
                }`}
              >
                <span className="text-base" style={{ fontFamily: f.previewFallback }}>
                  {f.label}
                </span>
              </button>
            ))}
          </div>
        )}

        {fontMode === "custom" && (
          <div className="flex flex-col gap-1.5">
            <Input
              value={fontFamilyInput}
              onChange={(e) => handleFontFamilyChange(e.target.value)}
              placeholder="e.g. Roboto Slab"
              aria-label="Custom font family"
            />
            <p className="text-xs text-muted-foreground">
              Loaded from Google Fonts by name. Names that don&apos;t match a real font
              silently fall back to the default typeface. Custom fonts load slightly
              slower than presets and may cause a brief flash of unstyled text (FOUC)
              on first paint.
            </p>
          </div>
        )}
      </div>

      {/* ── Logo ───────────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-3">
        <span className="text-sm font-medium">Logo</span>
        <div className="flex items-center gap-3">
          {logoUrl && (
            // eslint-disable-next-line @next/next/no-img-element -- external blob URL, size varies per upload
            <img
              src={logoUrl}
              alt="Workspace logo"
              className="w-10 h-10 rounded-lg object-cover border border-border"
            />
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={isUploading}
            onClick={() => fileInputRef.current?.click()}
          >
            {isUploading ? "Uploading..." : logoUrl ? "Replace logo" : "Upload logo"}
          </Button>
          {logoUrl && (
            <button
              type="button"
              onClick={handleRemoveLogo}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-destructive transition-colors"
            >
              <X className="w-3.5 h-3.5" />
              Remove logo
            </button>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={handleFileSelected}
          />
        </div>
        {logoError && <span className="text-xs text-destructive">{logoError}</span>}
      </div>
    </div>
  );
}
