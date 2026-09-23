"use server"

import { auth } from "@/auth"
import { revalidatePath } from "next/cache"
import { z } from "zod"
import { getResearchLinks, linkExperimentResearchStudy, unlinkExperimentResearchStudy, type ResearchLinkTarget } from "@/lib/experiment-research-links"

async function actor() {
  const session = await auth()
  if (!session?.user?.id) throw new Error("Unauthorized")
  return { userId: session.user.id, source: "UI" as const }
}

const scopeSchema = z.object({ orgSlug: z.string().trim().min(1).max(255), workspaceSlug: z.string().trim().min(1).max(255) })
const targetSchema = z.object({ type: z.enum(["experiment", "study"]), id: z.string().uuid() })
const pairSchema = z.object({ experimentId: z.string().uuid(), studyId: z.string().uuid() })

export async function readExperimentStudyLinks(orgSlug: string, workspaceSlug: string, target: ResearchLinkTarget, search = "") {
  if (target?.type !== "experiment" && target?.type !== "study") throw new Error("Invalid target")
  const scope = scopeSchema.parse({ orgSlug, workspaceSlug })
  return getResearchLinks(scope, await actor(), targetSchema.parse(target), z.string().max(255).parse(search))
}

export async function changeExperimentStudyLink(orgSlug: string, workspaceSlug: string, experimentId: string, studyId: string, operation: "link" | "unlink") {
  if (operation !== "link" && operation !== "unlink") throw new Error("Invalid operation")
  const scope = scopeSchema.parse({ orgSlug, workspaceSlug })
  const pair = pairSchema.parse({ experimentId, studyId })
  const result = await (operation === "link" ? linkExperimentResearchStudy : unlinkExperimentResearchStudy)(
    scope, await actor(), pair,
  )
  revalidatePath(`/${orgSlug}/${workspaceSlug}/experiments/${experimentId}`)
  revalidatePath(`/${orgSlug}/${workspaceSlug}/capture/studies/${studyId}`)
  return result
}
