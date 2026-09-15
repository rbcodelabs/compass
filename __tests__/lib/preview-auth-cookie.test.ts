import type { NextAuthConfig } from "next-auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PREVIEW_SESSION_COOKIE,
  PREVIEW_SESSION_OPTIONS,
} from "@/lib/preview-automation/cookies";

const mocks = vi.hoisted(() => ({
  getPrisma: vi.fn(),
  nextAuth: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ default: mocks.getPrisma }));
vi.mock("next-auth", () => ({ default: mocks.nextAuth }));
vi.mock("next-auth/providers/credentials", () => ({
  default: vi.fn(() => ({ id: "credentials" })),
}));
vi.mock("next-auth/providers/google", () => ({
  default: vi.fn(() => ({ id: "google" })),
}));
vi.mock("next-auth/providers/resend", () => ({
  default: vi.fn(() => ({ id: "resend" })),
}));

describe("preview session cookie pinning", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "production");
    mocks.getPrisma.mockReset();
    mocks.nextAuth.mockReset();
    mocks.nextAuth.mockReturnValue({
      handlers: {},
      auth: vi.fn(),
      signIn: vi.fn(),
      signOut: vi.fn(),
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("pins the Auth.js session cookie to the preview-automation cookie on Vercel preview with automation enabled", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("PREVIEW_AUTOMATION_ENABLED", "1");

    await import("@/auth");

    const config = mocks.nextAuth.mock.calls[0]?.[0] as NextAuthConfig;
    expect(config.cookies?.sessionToken?.name).toBe(PREVIEW_SESSION_COOKIE);
    expect(config.cookies?.sessionToken?.options).toEqual(
      PREVIEW_SESSION_OPTIONS
    );
  });

  it("does not override the session cookie on Vercel preview when automation is not explicitly enabled", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    // PREVIEW_AUTOMATION_ENABLED intentionally left unset.

    await import("@/auth");

    const config = mocks.nextAuth.mock.calls[0]?.[0] as NextAuthConfig;
    expect(config.cookies).toBeUndefined();
  });

  it("does not override the session cookie in production (non-preview)", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("PREVIEW_AUTOMATION_ENABLED", "1");

    await import("@/auth");

    const config = mocks.nextAuth.mock.calls[0]?.[0] as NextAuthConfig;
    expect(config.cookies).toBeUndefined();
  });
});
