import type { NextAuthConfig } from "next-auth";
import Resend from "next-auth/providers/resend";

// Edge-compatible auth config — no adapter, no Node.js-only modules.
// Used by middleware for JWT session checking.
// auth.ts imports this and adds the Prisma adapter for server components.
export const authConfig: NextAuthConfig = {
  providers: [
    Resend({
      from: process.env.AUTH_EMAIL_FROM ?? "Compass <noreply@compass.app>",
    }),
  ],
  pages: {
    signIn: "/login",
    verifyRequest: "/login?check-email=1",
  },
  callbacks: {
    authorized({ auth }) {
      return !!auth?.user;
    },
    session({ session, user }) {
      if (user) session.user.id = user.id;
      return session;
    },
  },
};
