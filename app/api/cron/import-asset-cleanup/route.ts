import { getArtifactStorage, getResearchArtifactStorage, privateProviderIdentity } from "@/lib/artifact-storage"
import { authorizeCron, cronAuthNotConfigured } from "@/lib/cron-auth"
import getPrisma from "@/lib/db"
import { configuredBlobStoreHostname } from "@/lib/feedback-attachments"
import { getPublicFileStore } from "@/lib/storage/public-store"
import { sweepAbandonedAssets } from "@/lib/workspace-export/abandoned-assets"

export const runtime = "nodejs"
export const maxDuration = 300

export async function GET(request: Request) {
  if (cronAuthNotConfigured()) return Response.json({ error: "Cleanup is not configured" }, { status: 503 })
  if (!authorizeCron(request)) return Response.json({ error: "Unauthorized" }, { status: 401 })
  const result = await sweepAbandonedAssets(getPrisma(), store => {
    if (store === "feedback") {
      const namespace = configuredBlobStoreHostname()
      return { provider: "blob", namespace, remove: key => getPublicFileStore().delete([`https://${namespace}/${key}`]) }
    }
    const provider = store === "artifact" ? getArtifactStorage() : getResearchArtifactStorage()
    return { ...privateProviderIdentity(store), remove: key => provider.del(key) }
  })
  return Response.json(result, { headers: { "Cache-Control": "no-store" } })
}
