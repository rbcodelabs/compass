import { PrismaAdapter } from "@auth/prisma-adapter";
import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { createLazyPrismaAuthAdapter } from "@/lib/lazy-prisma-auth-adapter";

describe("createLazyPrismaAuthAdapter", () => {
  it("does not initialize Prisma while constructing the adapter", () => {
    const getClient = vi.fn();

    createLazyPrismaAuthAdapter(getClient);

    expect(getClient).not.toHaveBeenCalled();
  });

  it("exposes every method provided by the concrete Prisma adapter", () => {
    const getClient = vi.fn();
    const concreteAdapter = PrismaAdapter({} as PrismaClient);

    const lazyAdapter = createLazyPrismaAuthAdapter(getClient);

    expect(Object.keys(lazyAdapter).sort()).toEqual(
      Object.keys(concreteAdapter).sort()
    );
    expect(lazyAdapter).toHaveProperty("createAuthenticator");
    expect(lazyAdapter).toHaveProperty("updateAuthenticatorCounter");
  });

  it("initializes Prisma once on first use and forwards arguments and results", async () => {
    const user = { id: "user-1", email: "rick@example.com" };
    const findUnique = vi.fn().mockResolvedValue(user);
    const getClient = vi.fn(() => ({
      user: { findUnique },
    }) as unknown as PrismaClient);
    const adapter = createLazyPrismaAuthAdapter(getClient);

    await expect(adapter.getUser?.("user-1")).resolves.toEqual(user);
    await expect(adapter.getUser?.("user-2")).resolves.toEqual(user);

    expect(getClient).toHaveBeenCalledTimes(1);
    expect(findUnique).toHaveBeenNthCalledWith(1, { where: { id: "user-1" } });
    expect(findUnique).toHaveBeenNthCalledWith(2, { where: { id: "user-2" } });
  });

  it("preserves missing-database errors until a DB-backed auth method is used", () => {
    const getClient = vi.fn(() => {
      throw new Error("Neither DATABASE_URL nor PGHOST is set.");
    });
    const adapter = createLazyPrismaAuthAdapter(getClient);

    expect(getClient).not.toHaveBeenCalled();
    expect(() => adapter.getUser?.("user-1")).toThrow(
      "Neither DATABASE_URL nor PGHOST is set."
    );
    expect(getClient).toHaveBeenCalledTimes(1);
  });
});
