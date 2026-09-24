import NextAuth from "next-auth";
import Resend from "next-auth/providers/resend";
import Google from "next-auth/providers/google";
import Credentials from "next-auth/providers/credentials";
import Passkey from "next-auth/providers/passkey";
import getPrisma from "@/lib/db";
import { authConfig } from "@/auth.config";
import { createLazyPrismaAuthAdapter } from "@/lib/lazy-prisma-auth-adapter";
import { PREVIEW_SESSION_COOKIE, PREVIEW_SESSION_OPTIONS } from "@/lib/preview-automation/cookies";

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
 *   • Resend (magic-link email) + Google (OAuth) + Passkey (WebAuthn) + PrismaAdapter (database sessions).
 *   • Credentials provider is absent — never ships in production.
 *   • Passkey registration/sign-in UI is additionally gated by
 *     lib/passkeys.ts's passkeysEnabled() — the provider itself is always
 *     registered here so /api/auth/webauthn-options exists whenever the flag
 *     is flipped on without a redeploy.
 *
 * Portal sessions and Auth.js sessions are intentionally non-interoperable.
 * Do not attempt to unify them. Portal accounts (public feedback/roadmap
 * visitors) live entirely in lib/portal-auth.ts — different cookie name,
 * different token format (opaque + DB-hashed, not JWT), different tables,
 * different code path end to end. See ADR: Claude/compass-portal-auth-adr-2026-07-03.md.
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
            // JWT claims survive profile edits; use the account as the identity source.
            const profile = await getPrisma().user.findUnique({
              where: { id: session.user.id }, select: { name: true, email: true },
            });
            if (profile) {
              session.user.name = profile.name;
              session.user.email = profile.email;
            }
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
        Passkey,
      ],
      adapter: createLazyPrismaAuthAdapter(),
      experimental: { enableWebAuthn: true },
      ...(process.env.VERCEL_ENV === "preview" && process.env.PREVIEW_AUTOMATION_ENABLED === "1" ? {
        cookies: { sessionToken: { name: PREVIEW_SESSION_COOKIE, options: PREVIEW_SESSION_OPTIONS } },
      } : {}),
    });
