import type { NextAuthConfig } from "next-auth";
import Resend from "next-auth/providers/resend";

// Edge-compatible auth config — no adapter, no Node.js-only modules.
// Used by middleware for JWT session checking.
// auth.ts imports this and adds the Prisma adapter for server components.
export const authConfig: NextAuthConfig = {
  providers: [
    Resend({
      from: process.env.AUTH_EMAIL_FROM ?? "Compass <noreply@compass.app>",
      // In local dev, log the magic link to the console instead of emailing it.
      ...(process.env.NODE_ENV === "development"
        ? {
            sendVerificationRequest({ url }) {
              console.log("\n🔗 MAGIC LINK (dev mode — check terminal):");
              console.log(url);
              console.log();
            },
          }
        : {}),
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
