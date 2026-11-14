/**
 * Runs lib/artifacts.ts functions under tsx (which resolves the repo's "@/" aliases) for the artifact-experiment E2E spec:
 * Playwright's own loader cannot import lib/links, and deleting an Artifact has no UI or tool path, so the spec shells out here.
 *   node --import tsx artifact-experiment-cli.ts read <workspaceId> <experimentId>             -> JSON array of artifact ids attached to the experiment
 *   node --import tsx artifact-experiment-cli.ts leftover <workspaceId> <artifactId>           -> how many link rows still name the artifact (removes them, so a clean delete prints 0)
 *   node --import tsx artifact-experiment-cli.ts delete <workspaceId> <artifactId>             -> deletes the artifact via deleteArtifact (sweeps its links)
 *   node --import tsx artifact-experiment-cli.ts delete-and-verify <wsId> <artId> <expId>      -> deletes the artifact, checks leftover links, and reads attached experiment artifacts ({ leftover, attached })
 */
import getPrisma from "../../../lib/db"
import { deleteArtifact, getExperimentArtifactIds } from "../../../lib/artifacts"
import { getArtifactStorage } from "../../../lib/artifact-storage"
import { deleteLinksForEntity } from "../../../lib/links/service"

async function main() {
  const [command, workspaceId, id, experimentId] = process.argv.slice(2)
  const prisma = getPrisma()
  try {
    if (command === "read") console.log(JSON.stringify(await getExperimentArtifactIds(prisma, workspaceId, id)))
    else if (command === "leftover") console.log(JSON.stringify(await deleteLinksForEntity(prisma, "ARTIFACT", [id])))
    else if (command === "delete") {
      await deleteArtifact({ artifactId: id, workspaceId }, getArtifactStorage())
      console.log(JSON.stringify({ deleted: true }))
    } else if (command === "delete-and-verify") {
      if (!experimentId) throw new Error("delete-and-verify requires <workspaceId> <artifactId> <experimentId>")
      await deleteArtifact({ artifactId: id, workspaceId }, getArtifactStorage())
      const leftover = await deleteLinksForEntity(prisma, "ARTIFACT", [id])
      const attached = await getExperimentArtifactIds(prisma, workspaceId, experimentId)
      console.log(JSON.stringify({ leftover, attached }))
    } else throw new Error(`Unknown command ${command}`)
  } finally {
    await prisma.$disconnect?.()
  }
}

main().catch((error) => { console.error(error); process.exit(1) })
