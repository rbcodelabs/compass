"use server"

import { auth } from "@/auth"
import getPrisma from "@/lib/db"
import { revalidatePath } from "next/cache"

export async function saveProfile(name: unknown): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = await auth()
  if (!session?.user?.id) return { ok: false, error: "Sign in to update your profile." }
  if (typeof name !== "string" || !name.trim() || name.trim().length > 120) {
    return { ok: false, error: "Enter a display name between 1 and 120 characters." }
  }
  try {
    await getPrisma().user.update({ where: { id: session.user.id }, data: { name: name.trim() } })
  } catch {
    return { ok: false, error: "Your profile could not be saved. Please try again." }
  }
  revalidatePath("/", "layout")
  return { ok: true }
}
