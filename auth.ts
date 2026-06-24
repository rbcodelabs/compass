import NextAuth from "next-auth";
import { PrismaAdapter } from "@auth/prisma-adapter";
import getPrisma from "@/lib/db";
import { authConfig } from "@/auth.config";

// getPrisma() is now synchronous — the OIDC token exchange and DB connection
// happen lazily when the first query runs, so it's safe to call at module load.
// PrismaAdapter receives a real client, not a proxy, so Auth.js adapter
// validation passes correctly.
export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  adapter: PrismaAdapter(getPrisma()),
});
