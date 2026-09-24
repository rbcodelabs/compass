import { PrismaAdapter } from "@auth/prisma-adapter";
import type { PrismaClient } from "@prisma/client";

import getPrisma, { type AppPrismaClient } from "@/lib/db";
import { getManagedPilotContext } from "@/lib/preview-automation/managed-context";

type GetPrisma = () => AppPrismaClient;

/**
 * Builds Auth.js's complete Prisma adapter without opening a database connection.
 * Prisma is resolved only when Auth.js invokes an adapter method that reads a
 * model, which keeps production builds independent of runtime-only credentials.
 */
export function createLazyPrismaAuthAdapter(
  initializePrisma: GetPrisma = getPrisma
): ReturnType<typeof PrismaAdapter> {
  let prisma: AppPrismaClient | undefined;

  // The Proxy target is declared as a base `PrismaClient` because that is what
  // `PrismaAdapter` accepts; every get is forwarded to the extended singleton
  // returned by `initializePrisma`. The two types differ only in the
  // client-level methods an extended client drops (`$on`/`$use`/`$extends`),
  // none of which Auth.js's adapter calls — it only touches the User, Account,
  // Session and VerificationToken delegates, and this file's own
  // previewAutomation* reads. Those models have no `updatedAt` column, so the
  // injection extension is a no-op for them either way.
  const lazyPrisma = new Proxy({} as PrismaClient, {
    get(_target, property) {
      getManagedPilotContext();
      prisma ??= initializePrisma();
      const value = Reflect.get(prisma, property, prisma);
      return typeof value === "function" ? value.bind(prisma) : value;
    },
  });

  const adapter = PrismaAdapter(lazyPrisma);
  async function automationDeadline(row: { sessionToken: string; userId: string }) {
    const managed = getManagedPilotContext();
    if (process.env.PREVIEW_AUTOMATION_ENABLED !== "1" || process.env.VERCEL_ENV !== "preview") return null;
    const association = await lazyPrisma.previewAutomationSession.findUnique({ where: { sessionToken: row.sessionToken } });
    if (!association) return null;
    const run = await lazyPrisma.previewAutomationRun.findUnique({ where: { id: association.runId } });
    if (managed && (run?.id !== managed.runId || run.workspaceId !== managed.workspaceId)) return null;
    if (!run || run.revokedAt || run.expiresAt.getTime() <= Date.now() || run.deploymentId !== process.env.VERCEL_DEPLOYMENT_ID ||
      ![run.ownerUserId, run.viewerUserId].includes(row.userId)) return null;
    return run.expiresAt;
  }
  return {
    ...adapter,
    async getSessionAndUser(sessionToken) {
      if (process.env.PREVIEW_DATABASE_MODE && process.env.PREVIEW_DATABASE_MODE !== "scoped-role" && !sessionToken.startsWith("preview_")) return null;
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
      if (process.env.PREVIEW_DATABASE_MODE && process.env.PREVIEW_DATABASE_MODE !== "scoped-role" && !data.sessionToken.startsWith("preview_")) return null;
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
