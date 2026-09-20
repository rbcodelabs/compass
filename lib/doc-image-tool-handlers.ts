import getPrisma from "@/lib/db"
import { prepareDocImageUpload } from "@/lib/doc-images"
import { fail, ok } from "@/lib/mcp-output"

export async function prepareDocImageUploadTool(input: { workspaceId: string; filename: string; fileType: string; fileSize: number }) {
  const workspace = await getPrisma().workspace.findUnique({ where: { id: input.workspaceId }, select: { id: true } })
  if (!workspace) return fail(`No workspace found with id "${input.workspaceId}".`)
  try {
    const prepared = await prepareDocImageUpload(input)
    return ok(["**Private Docs image upload prepared**", `ID: ${prepared.imageId}`, `Pathname: ${prepared.pathname}`, `Expires: ${new Date(prepared.expiresAt).toISOString()}`, `Image URL: ${prepared.url}`, `Markdown: ${prepared.markdown}`, "Upload with @vercel/blob/client put(pathname, file, { access: \"private\", token: clientToken, contentType: fileType })."].join("\n"), prepared)
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Could not prepare Docs image upload.")
  }
}
