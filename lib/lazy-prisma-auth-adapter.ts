import { PrismaAdapter } from "@auth/prisma-adapter";
import type { PrismaClient } from "@prisma/client";

import getPrisma from "@/lib/db";

type GetPrisma = () => PrismaClient;

/**
 * Builds Auth.js's complete Prisma adapter without opening a database connection.
 * Prisma is resolved only when Auth.js invokes an adapter method that reads a
 * model, which keeps production builds independent of runtime-only credentials.
 */
export function createLazyPrismaAuthAdapter(
  initializePrisma: GetPrisma = getPrisma
): ReturnType<typeof PrismaAdapter> {
  let prisma: PrismaClient | undefined;

  const lazyPrisma = new Proxy({} as PrismaClient, {
    get(_target, property) {
      prisma ??= initializePrisma();
      const value = Reflect.get(prisma, property, prisma);
      return typeof value === "function" ? value.bind(prisma) : value;
    },
  });

  return PrismaAdapter(lazyPrisma);
}
