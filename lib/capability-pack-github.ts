import { CAPABILITY_PACK_LIMITS, parseGithubPackSource } from "@/lib/capability-pack"
import { AGENTIC_PM_PACK } from "@/lib/capability-pack-curated"

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>
type GithubTreeItem = { path?: unknown; type?: unknown; mode?: unknown; sha?: unknown; size?: unknown }

const API_RESPONSE_LIMIT = 2 * 1024 * 1024
const FETCH_TIMEOUT_MS = 15_000

export async function resolveAgenticPmPackSource(fetcher: FetchLike = fetch) {
  const value = await boundedJson(await fetcher("https://api.github.com/repos/rbcodelabs/agent-pm-playbook/commits/heads%2Fmain", {
    headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    redirect: "error", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), cache: "no-store",
  }))
  if (!value || typeof value !== "object" || !("sha" in value) || typeof value.sha !== "string" || !/^[a-f0-9]{40}$/.test(value.sha)) throw new Error("GitHub did not resolve a full immutable commit SHA")
  return { repositoryUrl: AGENTIC_PM_PACK.repositoryUrl, packPath: AGENTIC_PM_PACK.packPath, commitSha: value.sha }
}

async function boundedJson(response: Response, maxBytes = API_RESPONSE_LIMIT): Promise<unknown> {
  if (!response.ok || response.redirected || (response.status >= 300 && response.status < 400)) throw new Error(`GitHub request failed (${response.status})`)
  if (!response.headers.get("content-type")?.toLowerCase().includes("application/json")) throw new Error("GitHub returned an unexpected content type")
  const declared = Number(response.headers.get("content-length") ?? 0)
  if (declared > maxBytes) throw new Error("GitHub response exceeds size limit")
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength > maxBytes) throw new Error("GitHub response exceeds size limit")
  return JSON.parse(new TextDecoder().decode(bytes))
}

export async function fetchGithubCapabilityPack(
  source: { repositoryUrl: string; commitSha: string; packPath: string },
  fetcher: FetchLike = fetch
): Promise<Map<string, Uint8Array>> {
  const parsed = parseGithubPackSource(source.repositoryUrl, source.commitSha, source.packPath)
  const request = async (url: string) => fetcher(url, {
    headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    redirect: "error",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  const apiRoot = `https://api.github.com/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}`
  const commitValue = await boundedJson(await request(`${apiRoot}/git/commits/${parsed.commitSha}`)) as { sha?: unknown; tree?: { sha?: unknown } }
  if (commitValue.sha !== parsed.commitSha || typeof commitValue.tree?.sha !== "string") throw new Error("GitHub SHA did not resolve to the requested commit")
  const treeValue = await boundedJson(await request(`${apiRoot}/git/trees/${commitValue.tree.sha}?recursive=1`))
  const tree = treeValue as { tree?: unknown; truncated?: unknown }
  if (tree.truncated === true) throw new Error("GitHub repository tree is truncated")
  if (!Array.isArray(tree.tree)) throw new Error("GitHub repository tree is invalid")
  const prefix = `${parsed.packPath}/`
  const selected = (tree.tree as GithubTreeItem[]).filter((item) => item.type === "blob" && typeof item.path === "string" && item.path.startsWith(prefix))
  let total = 0
  for (const item of selected) {
    if (item.mode === "120000") throw new Error(`Capability packs cannot contain symlinks: ${item.path}`)
    if (typeof item.sha !== "string" || typeof item.size !== "number" || item.size < 0) throw new Error("GitHub tree contains invalid blob metadata")
    if (item.size > CAPABILITY_PACK_LIMITS.fileBytes) throw new Error(`Pack file exceeds 256 KiB: ${item.path}`)
    total += item.size
    if (total > CAPABILITY_PACK_LIMITS.packBytes) throw new Error("Capability pack exceeds 1 MiB")
  }
  if (selected.length === 0) throw new Error("No files found at the requested pack path")
  const files = new Map<string, Uint8Array>()
  for (const item of selected.sort((a, b) => String(a.path).localeCompare(String(b.path)))) {
    const blob = await boundedJson(await request(`https://api.github.com/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/git/blobs/${item.sha}`), CAPABILITY_PACK_LIMITS.fileBytes * 2)
    const record = blob as { content?: unknown; encoding?: unknown; size?: unknown }
    if (record.encoding !== "base64" || typeof record.content !== "string") throw new Error("GitHub blob response is invalid")
    const bytes = new Uint8Array(Buffer.from(record.content.replace(/\s/g, ""), "base64"))
    if (bytes.byteLength > CAPABILITY_PACK_LIMITS.fileBytes || bytes.byteLength !== item.size) throw new Error(`GitHub blob size mismatch: ${item.path}`)
    files.set((item.path as string).slice(prefix.length), bytes)
  }
  return files
}
