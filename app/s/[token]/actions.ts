"use server"

import { cookies } from "next/headers"
import { redirect } from "next/navigation"
import { SHARE_SESSION_TTL_MS, resolveShareByToken, shareSessionCookieName, unlockShare } from "@/lib/artifact-share"

export type UnlockFormState = { error: string | null }

const GENERIC_ERROR = "That link or password isn't valid."
const LOCKED_ERROR = "Too many incorrect attempts. Try again in a few minutes."

/**
 * Unlock a shared artifact. Unknown link and wrong password answer identically, so this
 * cannot be used to learn which links exist.
 */
export async function unlockShareAction(_previous: UnlockFormState, formData: FormData): Promise<UnlockFormState> {
  const token = formData.get("token")
  const password = formData.get("password")
  if (typeof token !== "string" || typeof password !== "string") return { error: GENERIC_ERROR }

  const result = await unlockShare(token, password)
  if (!result.ok) return { error: result.reason === "locked" ? LOCKED_ERROR : GENERIC_ERROR }

  // Cookie is scoped to this one share's path, so it is never sent anywhere else on the origin.
  const share = await resolveShareByToken(token)
  if (!share) return { error: GENERIC_ERROR }
  ;(await cookies()).set(shareSessionCookieName(token), result.sessionToken, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: `/s/${token}`,
    maxAge: Math.floor(SHARE_SESSION_TTL_MS / 1000),
  })
  redirect(`/s/${token}`)
}
