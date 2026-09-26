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
vi.mock("next-auth/providers/passkey", () => ({
  default: { id: "passkey" },
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

  it("registers the Passkey provider and enables the WebAuthn experimental flag", async () => {
    await import("@/auth");

    const config = mocks.nextAuth.mock.calls[0]?.[0] as NextAuthConfig;
    expect(config.providers).toContainEqual({ id: "passkey" });
    expect(config.experimental).toEqual({ enableWebAuthn: true });
  });
});

describe("dev auth initialization", () => {
  it("loads the current persisted profile rather than the stale JWT name", async () => {
    const findUnique = vi.fn().mockResolvedValue({ name: "Current name", email: "person@example.com" });
    mocks.getPrisma.mockReturnValue({ user: { findUnique } });
    await import("@/auth");
    const config = mocks.nextAuth.mock.calls[0]?.[0] as NextAuthConfig;
    const session = { user: { id: "", name: "Old name", email: "old@example.com" }, expires: "2099-01-01" };
    // Exercise the JWT strategy callback; its union type also covers database sessions.
    const callback = config.callbacks!.session as (args: unknown) => Promise<typeof session>;
    await expect(callback({ session, token: { id: "owner" } })).resolves.toMatchObject({ user: { id: "owner", name: "Current name", email: "person@example.com" } });
    expect(findUnique).toHaveBeenCalledWith({ where: { id: "owner" }, select: { name: true, email: true } });
  });
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "development");
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

  it("never registers the Passkey provider or the WebAuthn experimental flag", async () => {
    await import("@/auth");

    const config = mocks.nextAuth.mock.calls[0]?.[0] as NextAuthConfig;
    expect(config.providers).not.toContainEqual({ id: "passkey" });
    expect(config.experimental?.enableWebAuthn).not.toBe(true);
  });
});
