import { appendFile, readFile, stat } from "node:fs/promises"
import { resolveTarget } from "./resolve"
async function validate() {
  if (process.env.PREVIEW_RELAY_FILE) {
    const info = await stat(process.env.PREVIEW_RELAY_FILE)
    if (!info.isFile() || info.size > 2048) throw new Error("Invalid relay artifact")
    const hint = JSON.parse(await readFile(process.env.PREVIEW_RELAY_FILE, "utf8"))
    if (typeof hint.deployment !== "string") throw new Error("Invalid deployment hint")
    // Artifact is data only. resolveTarget verifies it against both provider APIs.
    process.env.PREVIEW_DEPLOYMENT_ID = hint.deployment
  }
  const target = await resolveTarget()
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, Object.entries(target).map(([key,value]) => `${key}=${value}\n`).join(""))
  console.log(JSON.stringify(target))
}
validate().catch(() => { console.error("Preview target validation failed"); process.exitCode = 1 })
