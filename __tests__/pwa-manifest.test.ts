import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import manifest from "@/app/manifest";
import { isPublicPath } from "@/lib/route-access";

describe("PWA manifest", () => {
  const result = manifest();

  it("is installable: standalone with a start URL and 192 + 512 icons", () => {
    expect(result.display).toBe("standalone");
    expect(result.start_url).toBe("/");
    const sizes = (result.icons ?? []).map((icon) => icon.sizes);
    expect(sizes).toContain("192x192");
    expect(sizes).toContain("512x512");
    expect((result.icons ?? []).some((icon) => icon.purpose === "maskable")).toBe(true);
  });

  it("references icon files that exist and are reachable without a session", () => {
    for (const icon of result.icons ?? []) {
      expect(existsSync(path.join(process.cwd(), "public", icon.src))).toBe(true);
      expect(isPublicPath(icon.src)).toBe(true);
    }
  });
});
