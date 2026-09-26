import { afterEach, expect, it, vi } from "vitest";
import { authConfig } from "@/auth.config";
afterEach(() => vi.unstubAllEnvs());
it("disables OAuth and email sign-in in the signed-session-only managed pilot", async () => {
  vi.stubEnv("PREVIEW_DATABASE_MODE", "vercel-managed");
  const result = authConfig.callbacks?.signIn ? await authConfig.callbacks.signIn({ user: { id: "user" }, account: null }) : true;
  expect(result).toBe(false);
});
