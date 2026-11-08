/**
 * Runs lib/artifacts.ts functions under tsx (which resolves the repo's "@/" aliases) for the artifact-experiment E2E spec:
 * Playwright's own loader cannot import lib/links, and deleting an Artifact has no UI or tool path, so the spec shells out here.
 *   tsx artifact-experiment-cli.ts read <workspaceId> <experimentId>   -> JSON array of artifact ids attached to the experiment
 *   tsx artifact-experiment-cli.ts leftover <workspaceId> <artifactId> -> how many link rows still name the artifact (removes them, so a clean delete prints 0)
 *   tsx artifact-experiment-cli.ts delete <workspaceId> <artifactId>   -> deletes the artifact via deleteArtifact (sweeps its links)
 */
import getPrisma from "../../../lib/db"
import { deleteArtifact, getExperimentArtifactIds } from "../../../lib/artifacts"
import { getArtifactStorage } from "../../../lib/artifact-storage"
import { deleteLinksForEntity } from "../../../lib/links/service"

const [command, workspaceId, id] = process.argv.slice(2)
const prisma = getPrisma()
try {
  if (command === "read") console.log(JSON.stringify(await getExperimentArtifactIds(prisma, workspaceId, id)))
  else if (command === "leftover") console.log(JSON.stringify(await deleteLinksForEntity(prisma, "ARTIFACT", [id])))
  else if (command === "delete") { await deleteArtifact({ artifactId: id, workspaceId }, getArtifactStorage()); console.log(JSON.stringify({ deleted: true })) }
  else throw new Error(`Unknown command ${command}`)
} finally {
  await prisma.$disconnect?.()
}
