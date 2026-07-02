import NextAuth from "next-auth";
import Resend from "next-auth/providers/resend";
import Google from "next-auth/providers/google";
import Credentials from "next-auth/providers/credentials";
import { PrismaAdapter } from "@auth/prisma-adapter";
import getPrisma from "@/lib/db";
import { authConfig } from "@/auth.config";

/**
 * Auth.js setup — two distinct configurations:
 *
 * DEVELOPMENT (NODE_ENV=development):
 *   • Only a Credentials provider ("dev-credentials") — no email, no token flow.
 *   • JWT session strategy (Credentials requires JWT; no adapter needed).
 *   • The proxy.ts imports `auth` from here; because Credentials is the only
 *     provider, auth.js won't complain about MissingAdapter.
 *
 * PRODUCTION (Vercel preview / prod):
 *   • Resend (magic-link email) + Google (OAuth) + PrismaAdapter (database sessions).
 *   • Credentials provider is absent — never ships in production.
 */

const isDev = process.env.NODE_ENV === "development";

export const { handlers, auth, signIn, signOut } = isDev
  ? // ── Dev mode: instant login via Credentials ──────────────────────────────
    NextAuth({
      ...authConfig,
      providers: [
        Credentials({
          id: "dev-credentials",
          name: "Dev Login",
          credentials: {
            email: { label: "Email", type: "text" },
          },
          async authorize(credentials) {
            const prisma = getPrisma();
            const email =
              (credentials?.email as string | undefined) ?? "dev@localhost.dev";
            // Upsert the dev user so the id is stable across restarts.
            const user = await prisma.user.upsert({
              where: { email },
              update: {},
              create: {
                email,
                name: "Dev User",
                emailVerified: new Date(),
              },
            });
            return { id: user.id, email: user.email, name: user.name };
          },
        }),
      ],
      session: { strategy: "jwt" },
      // No adapter — JWT sessions don't need one.
      callbacks: {
        ...authConfig.callbacks,
        // Embed user.id in JWT so session.user.id works everywhere.
        async jwt({ token, user }) {
          if (user) token.id = user.id;
          return token;
        },
        async session({ session, token }) {
          if (token?.id && session.user) {
            session.user.id = token.id as string;
          }
          return session;
        },
      },
    })
  : // ── Production: Resend magic-link + PrismaAdapter ────────────────────────
    NextAuth({
      ...authConfig,
      providers: [
        Resend({
          from:
            process.env.AUTH_EMAIL_FROM ?? "Compass <noreply@compass.app>",
        }),
        Google({
          clientId: process.env.AUTH_GOOGLE_ID,
          clientSecret: process.env.AUTH_GOOGLE_SECRET,
          // Same email via Resend magic-link should just link, not throw
          // OAuthAccountNotLinked — safe because Google verifies email ownership.
          allowDangerousEmailAccountLinking: true,
        }),
      ],
      adapter: PrismaAdapter(getPrisma()),
    });
