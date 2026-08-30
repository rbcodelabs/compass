import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const configSource = readFileSync(
  resolve(process.cwd(), "playwright.config.ts"),
  "utf8",
);

describe("Playwright deployment-protection configuration", () => {
  it("sources the Vercel automation bypass credential from the environment", () => {
    expect(
      configSource.includes("process.env.VERCEL_AUTOMATION_BYPASS_SECRET"),
    ).toBe(true);
  });

  it("never assigns a string literal to the deployment-protection header", () => {
    const hasLiteralBypassCredential =
      /["']x-vercel-protection-bypass["']\s*:\s*["'][^"']+["']/.test(
        configSource,
      );

    expect(hasLiteralBypassCredential).toBe(false);
  });
});
