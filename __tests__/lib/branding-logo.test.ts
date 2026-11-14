import { afterEach, describe, expect, it, vi } from "vitest";
import { brandingLogoPathname, isOwnBrandingLogoUrl, sniffBrandingLogoType } from "@/lib/branding-logo";

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0];
const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0];
const GIF = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0, 0, 0];
const WEBP = [0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50];
const SVG = Array.from(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>'));

describe("sniffBrandingLogoType", () => {
  it.each([
    ["png", PNG, "image/png", "png"],
    ["jpeg", JPEG, "image/jpeg", "jpg"],
    ["gif", GIF, "image/gif", "gif"],
    ["webp", WEBP, "image/webp", "webp"],
  ])("recognises %s from its bytes", (_n, bytes, contentType, ext) => {
    expect(sniffBrandingLogoType(new Uint8Array(bytes))).toEqual({ contentType, ext });
  });

  it("refuses SVG, HTML and empty input", () => {
    expect(sniffBrandingLogoType(new Uint8Array(SVG))).toBeNull();
    expect(sniffBrandingLogoType(new TextEncoder().encode("<html><script>1</script></html>"))).toBeNull();
    expect(sniffBrandingLogoType(new Uint8Array())).toBeNull();
  });
});

describe("brandingLogoPathname", () => {
  it("is server-generated under branding/ and unique", () => {
    const a = brandingLogoPathname({ contentType: "image/png", ext: "png" });
    const b = brandingLogoPathname({ contentType: "image/png", ext: "png" });
    expect(a).toMatch(/^branding\/[0-9a-f-]{36}-logo\.png$/);
    expect(a).not.toBe(b);
  });
});

describe("isOwnBrandingLogoUrl", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("accepts only branding/ URLs on this deployment's store host", () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "vercel_blob_rw_Abc123_secretpart");
    expect(isOwnBrandingLogoUrl("https://abc123.public.blob.vercel-storage.com/branding/x-logo.png")).toBe(true);
    expect(isOwnBrandingLogoUrl("https://abc123.public.blob.vercel-storage.com/other/x.png")).toBe(false);
    expect(isOwnBrandingLogoUrl("https://abc123.public.blob.vercel-storage.com/branding/x.png?a=1")).toBe(false);
    expect(isOwnBrandingLogoUrl("https://other.public.blob.vercel-storage.com/branding/x.png")).toBe(false);
    expect(isOwnBrandingLogoUrl("http://abc123.public.blob.vercel-storage.com/branding/x.png")).toBe(false);
    expect(isOwnBrandingLogoUrl("javascript:alert(1)")).toBe(false);
    expect(isOwnBrandingLogoUrl("not a url")).toBe(false);
  });

  it("accepts nothing when no Blob store is configured", () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
    expect(isOwnBrandingLogoUrl("https://abc123.public.blob.vercel-storage.com/branding/x-logo.png")).toBe(false);
  });
});
