import getPrisma, { type AppTransactionClient } from "@/lib/db"
import {
  issueAuthorizationCode,
  type AuthorizationCodeInput,
  type IssuedAuthorizationCode,
} from "@/lib/oauth/codes"

export const OAUTH_USER_AUTHORIZATION_EVENT = "USER_OVERRIDE_AUTHORIZED" as const
export const OAUTH_AUTHORIZATION_EVENT_SOURCES = [
  "INTERACTIVE_CONSENT",
  "REMEMBERED_CONSENT",
] as const

export type OAuthAuthorizationEventSource = typeof OAUTH_AUTHORIZATION_EVENT_SOURCES[number]

export type OAuthAuthorizationEventContext = {
  source: OAuthAuthorizationEventSource
  /** Snapshot at authorization time; OAuth client names are attacker-chosen. */
  clientNameSnapshot: string
}

type AuthorizationWriteClient = Pick<
  AppTransactionClient,
  "oAuthAuthorizationCode" | "oAuthAuthorizationEvent"
>

/**
 * Issue one code and, only for USER mode, its immutable authorization event.
 * The caller supplies the transaction so interactive consent can include its
 * consent upsert in the same boundary.
 */
export async function issueAuthorizationCodeWithEventInTransaction(
  input: AuthorizationCodeInput,
  context: OAuthAuthorizationEventContext,
  now: Date,
  prisma: AuthorizationWriteClient,
): Promise<IssuedAuthorizationCode> {
  const issued = await issueAuthorizationCode(input, now, prisma)
  if (input.authorizationMode !== "USER") return issued

  const redirectOrigin = new URL(input.redirectUri).origin
  if (redirectOrigin === "null") {
    // Registered redirects are HTTPS or HTTP loopback. Refuse rather than
    // persisting an ambiguous origin if that invariant ever regresses.
    throw new Error("OAuth authorization redirect has no auditable origin.")
  }

  await prisma.oAuthAuthorizationEvent.create({
    data: {
      eventType: OAUTH_USER_AUTHORIZATION_EVENT,
      source: context.source,
      authorizationCodeId: issued.authorizationCodeId,
      userId: input.userId,
      clientId: input.clientId,
      clientNameSnapshot: context.clientNameSnapshot,
      redirectOrigin,
      authorizationMode: "USER",
      agentId: null,
      scope: input.scope,
      createdAt: now,
    },
  })
  return issued
}

/** Code + USER event are indivisible; audit failure means no code is returned. */
export async function issueAuthorizationCodeWithEvent(
  input: AuthorizationCodeInput,
  context: OAuthAuthorizationEventContext,
  now: Date = new Date(),
): Promise<IssuedAuthorizationCode> {
  return getPrisma().$transaction((tx) =>
    issueAuthorizationCodeWithEventInTransaction(input, context, now, tx),
  )
}
