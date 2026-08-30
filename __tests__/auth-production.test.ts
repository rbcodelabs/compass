import type { NextAuthConfig } from "next-auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

describe("production auth initialization", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "production");
    mocks.getPrisma.mockReset();
    mocks.getPrisma.mockImplementation(() => {
      throw new Error("Neither DATABASE_URL nor PGHOST is set.");
    });
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

  it("imports without initializing Prisma and defers config errors to async adapter use", async () => {
    await import("@/auth");

    expect(mocks.nextAuth).toHaveBeenCalledTimes(1);
    expect(mocks.getPrisma).not.toHaveBeenCalled();

    const config = mocks.nextAuth.mock.calls[0]?.[0] as NextAuthConfig;
    await expect(
      config.adapter?.getAccount?.("account-1", "google")
    ).rejects.toThrow("Neither DATABASE_URL nor PGHOST is set.");
    expect(mocks.getPrisma).toHaveBeenCalledTimes(1);
  });
});
