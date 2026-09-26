import type { NextAuthConfig } from "next-auth";

// Edge-compatible auth config — NO providers listed here.
// Middleware runs in the Edge runtime and only needs to check whether a JWT
// session cookie is present. Email/magic-link providers (like Resend) require
// a database adapter to store tokens, which cannot run in Edge runtime.
// auth.ts (Node.js only) spreads this config and adds providers + PrismaAdapter.
export const authConfig: NextAuthConfig = {
  providers: [],
  pages: {
    signIn: "/login",
    verifyRequest: "/login?check-email=1",
  },
  callbacks: {
    signIn() {
      // Managed pilot identities are issued only by deployment-bound signed grants.
      return !process.env.PREVIEW_DATABASE_MODE || process.env.PREVIEW_DATABASE_MODE === "scoped-role";
    },
    authorized({ auth }) {
      return !!auth?.user;
    },
    session({ session, user }) {
      if (user) session.user.id = user.id;
      return session;
    },
  },
};
