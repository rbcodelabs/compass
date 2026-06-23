import NextAuth from "next-auth";
import { PrismaAdapter } from "@auth/prisma-adapter";
import Google from "next-auth/providers/google";
import type { Adapter } from "next-auth/adapters";
import getPrisma from "@/lib/db";

// Lazy adapter: defers PrismaClient initialization to the first auth operation.
// getPrisma() caches the client globally (see lib/db.ts), so the async hit is
// only taken once per server lifetime.
let _adapter: Adapter | null = null;

async function resolveAdapter(): Promise<Adapter> {
  if (!_adapter) {
    const prisma = await getPrisma();
    _adapter = PrismaAdapter(prisma) as Adapter;
  }
  return _adapter;
}

// All methods exposed by @auth/prisma-adapter. Drives the Proxy's ownKeys trap
// so Object.keys(adapter) returns them — required because @auth/core's
// adapterErrorHandler does Object.keys(adapter).reduce(...) to wrap each method.
// Without ownKeys the target is {} so Object.keys returns [] and every method
// gets silently dropped, producing "getUserByEmail is not a function" at runtime.
const ADAPTER_METHODS = [
  "createUser",
  "getUser",
  "getUserByEmail",
  "getUserByAccount",
  "updateUser",
  "deleteUser",
  "linkAccount",
  "unlinkAccount",
  "getSessionAndUser",
  "createSession",
  "updateSession",
  "deleteSession",
  "createVerificationToken",
  "useVerificationToken",
  "getAccount",
] as const;

// Proxy adapter that transparently awaits the PrismaClient before each call.
// Traps needed:
//   has                    — `"method" in adapter` checks at config-assertion time
//   ownKeys + getOwnPropertyDescriptor — Object.keys() in adapterErrorHandler
//   get                    — actual method dispatch, deferred until first call
const lazyAdapter: Adapter = new Proxy({} as Adapter, {
  has(_target, _prop: PropertyKey) {
    return true;
  },
  ownKeys(_target) {
    return [...ADAPTER_METHODS];
  },
  getOwnPropertyDescriptor(_target, prop) {
    if ((ADAPTER_METHODS as readonly string[]).includes(prop as string)) {
      return { configurable: true, enumerable: true, writable: true };
    }
    return undefined;
  },
  get(_target, prop: PropertyKey) {
    return async (...args: unknown[]) => {
      const adapter = await resolveAdapter();
      const method = (adapter as Record<PropertyKey, unknown>)[prop];
      if (typeof method === "function") {
        return (method as (...a: unknown[]) => unknown).apply(adapter, args);
      }
      return method;
    };
  },
});

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: lazyAdapter,

  // Auth.js reads AUTH_GOOGLE_ID and AUTH_GOOGLE_SECRET from the environment.
  providers: [Google],

  pages: {
    signIn: "/login",
  },

  callbacks: {
    session({ session, user }) {
      // Expose user.id in the session token so server components can read it.
      if (user) session.user.id = user.id;
      return session;
    },
  },
});
