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

describe("production Google sign-in via Vercel Connect", () => {
  type Provider = { id: string; allowDangerousEmailAccountLinking?: boolean; clientId?: string; profile?: (p: unknown, t: unknown) => unknown };
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "production");
    mocks.nextAuth.mockReset();
    mocks.nextAuth.mockReturnValue({ handlers: {}, auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() });
  });
  afterEach(() => vi.unstubAllEnvs());

  async function providers(): Promise<Provider[]> {
    await import("@/auth");
    return (mocks.nextAuth.mock.calls[0]?.[0] as NextAuthConfig).providers as unknown as Provider[];
  }
  const ids = (list: Provider[]) => list.map((p) => p.id);

  it("omits Google but keeps magic link and passkey when COMPASS_GOOGLE_CONNECTOR is unset", async () => {
    vi.stubEnv("COMPASS_GOOGLE_CONNECTOR", "");
    expect(ids(await providers())).toEqual(["resend", "passkey"]);
  });

  it("registers Google as provider id 'google' backed by the configured connector", async () => {
    vi.stubEnv("COMPASS_GOOGLE_CONNECTOR", "google/compass");
    const list = await providers();
    expect(ids(list)).toEqual(["resend", "google", "passkey"]);
    const google = list.find((p) => p.id === "google")!;
    expect(google.clientId).toBe("google/compass");
    expect(google.allowDangerousEmailAccountLinking).toBe(true);
  });

  it("maps a verified Google profile", async () => {
    vi.stubEnv("COMPASS_GOOGLE_CONNECTOR", "google/compass");
    const google = (await providers()).find((p) => p.id === "google")!;
    expect(google.profile!({ sub: "opaque-sub", email: "a@b.co", email_verified: true, name: "A", picture: "p" }, {})).toMatchObject({
      id: "opaque-sub",
      email: "a@b.co",
    });
  });

  it.each([
    ["email_verified=false", { sub: "s", email: "a@b.co", email_verified: false }],
    ["email_verified missing (Connect does not map it)", { sub: "s", email: "a@b.co" }],
    ["email_verified as a string", { sub: "s", email: "a@b.co", email_verified: "true" }],
    ["no email", { sub: "s", email_verified: true }],
  ])("refuses sign-in when %s, so email account linking stays safe", async (_label, profile) => {
    vi.stubEnv("COMPASS_GOOGLE_CONNECTOR", "google/compass");
    const google = (await providers()).find((p) => p.id === "google")!;
    expect(() => google.profile!(profile, {})).toThrow(/Google sign-in refused/);
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
