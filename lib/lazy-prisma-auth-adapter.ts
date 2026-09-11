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

  const adapter = PrismaAdapter(lazyPrisma);
  async function automationDeadline(row: { sessionToken: string; userId: string }) {
    if (process.env.PREVIEW_AUTOMATION_ENABLED !== "1" || process.env.VERCEL_ENV !== "preview") return null;
    const association = await lazyPrisma.previewAutomationSession.findUnique({ where: { sessionToken: row.sessionToken } });
    if (!association) return null;
    const run = await lazyPrisma.previewAutomationRun.findUnique({ where: { id: association.runId } });
    if (!run || run.revokedAt || run.expiresAt.getTime() <= Date.now() || run.deploymentId !== process.env.VERCEL_DEPLOYMENT_ID ||
      ![run.ownerUserId, run.viewerUserId].includes(row.userId)) return null;
    return run.expiresAt;
  }
  return {
    ...adapter,
    async getSessionAndUser(sessionToken) {
      if (!sessionToken.startsWith("preview_")) return adapter.getSessionAndUser!(sessionToken);
      const row = await lazyPrisma.session.findUnique({ where: { sessionToken }, include: { user: true } });
      if (!row) return null;
      const deadline = await automationDeadline(row);
      if (deadline === null) return null;
      const { user, ...session } = row;
      if (deadline && session.expires > deadline) session.expires = deadline;
      return { user, session };
    },
    async updateSession(data) {
      // ADR-0009 preview-login sessions (lib/preview-login.ts): Auth.js's own
      // core session action unconditionally tries to roll a database
      // session's expiry forward to `now + session.maxAge` (30 days by
      // default) once it's within `updateAge` of its stored expiry — and
      // with a 60-minute total lifetime, that window is hit on literally
      // the next request after login. Confirmed live: without this guard,
      // the very first subsequent navigation silently re-extended the
      // session far past its intended hard cap. A `previewlogin_` token has
      // no run registry to clamp against (unlike `preview_`, handled
      // below) — its entire security property IS that `expires`, once set
      // at issuance, is never written again. Returning null here (a valid
      // "no update performed" adapter result) refuses every such attempt;
      // Auth.js's own expiry check (`session.expires < now`) then enforces
      // the original cutoff exactly, independent of what the response
      // cookie's Max-Age cosmetically claims.
      if (data.sessionToken.startsWith("previewlogin_")) return null;
      if (!data.sessionToken.startsWith("preview_")) return adapter.updateSession!(data);
      const row = await lazyPrisma.session.findUnique({ where: { sessionToken: data.sessionToken } });
      if (!row) return null;
      const deadline = await automationDeadline(row);
      if (deadline === null) return null;
      return adapter.updateSession!({ ...data, ...(deadline ? { expires: new Date(Math.min(data.expires?.getTime() ?? deadline.getTime(), deadline.getTime())) } : {}) });
    },
  };
}
