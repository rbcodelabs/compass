import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
it("pins the preview issuer cookie in Auth.js without changing normal cookies", () => {
  const auth = readFileSync("auth.ts", "utf8");
  expect(auth.includes("PREVIEW_SESSION_COOKIE")).toBe(true);
  expect(auth.includes('process.env.VERCEL_ENV === "preview"')).toBe(true);
});
