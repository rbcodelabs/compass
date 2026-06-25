import NextAuth from "next-auth";
import Resend from "next-auth/providers/resend";
import { PrismaAdapter } from "@auth/prisma-adapter";
import getPrisma from "@/lib/db";
import { authConfig } from "@/auth.config";

// Dev-only: capture the last magic-link URL in a Node.js global so the
// instant-login server action can redirect straight to it (no email needed).
declare global {
  // eslint-disable-next-line no-var
  var __devMagicLinkUrl: string | undefined;
}

// getPrisma() is now synchronous — the OIDC token exchange and DB connection
// happen lazily when the first query runs, so it's safe to call at module load.
// PrismaAdapter receives a real client, not a proxy, so Auth.js adapter
// validation passes correctly.
export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  // In development, override providers so we can stash the callback URL in
  // globalThis — lets the instant-login button skip the email step entirely.
  // auth.config.ts keeps its own console.log for edge/middleware usage.
  providers:
    process.env.NODE_ENV === "development"
      ? [
          Resend({
            from:
              process.env.AUTH_EMAIL_FROM ?? "Compass <noreply@compass.app>",
            sendVerificationRequest({ url }) {
              console.log("\n🔗 MAGIC LINK (dev mode — check terminal):");
              console.log(url);
              console.log();
              globalThis.__devMagicLinkUrl = url;
            },
          }),
        ]
      : authConfig.providers,
  adapter: PrismaAdapter(getPrisma()),
});
