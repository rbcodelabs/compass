import { describe, expect, it, vi } from "vitest"
import { fetchGithubCapabilityPack } from "@/lib/capability-pack-github"

const SHA = "0123456789abcdef0123456789abcdef01234567"

describe("GitHub capability pack fetch", () => {
  const commitResponse = () => new Response(JSON.stringify({ sha: SHA, tree: { sha: "tree-sha" } }), { headers: { "content-type": "application/json" } })
  it("loads only the requested tree with bounded GitHub API responses", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(commitResponse())
      .mockResolvedValueOnce(new Response(JSON.stringify({ tree: [
        { path: "packs/compass/compass-pack.json", type: "blob", sha: "a", size: 2 },
        { path: "packs/compass/skills/one/SKILL.md", type: "blob", sha: "b", size: 5 },
        { path: "outside.txt", type: "blob", sha: "c", size: 9999999 },
      ], truncated: false }), { headers: { "content-type": "application/json", "content-length": "500" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ content: Buffer.from("{}").toString("base64"), encoding: "base64" }), { headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ content: Buffer.from("skill").toString("base64"), encoding: "base64" }), { headers: { "content-type": "application/json" } }))

    const files = await fetchGithubCapabilityPack({ repositoryUrl: "https://github.com/o/r", commitSha: SHA, packPath: "packs/compass" }, fetcher)
    expect([...files.keys()]).toEqual(["compass-pack.json", "skills/one/SKILL.md"])
    expect(fetcher).toHaveBeenCalledTimes(4)
    expect(String(fetcher.mock.calls[0][0])).toContain(`/git/commits/${SHA}`)
    expect(String(fetcher.mock.calls[1][0])).toContain(`/git/trees/tree-sha?recursive=1`)
  })

  it("fails closed on redirects, truncated trees and oversized declared blobs", async () => {
    await expect(fetchGithubCapabilityPack({ repositoryUrl: "https://github.com/o/r", commitSha: SHA, packPath: "pack" },
      vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location: "https://evil.test" } })))).rejects.toThrow(/GitHub/i)
    await expect(fetchGithubCapabilityPack({ repositoryUrl: "https://github.com/o/r", commitSha: SHA, packPath: "pack" },
      vi.fn().mockResolvedValueOnce(commitResponse()).mockResolvedValueOnce(new Response(JSON.stringify({ tree: [], truncated: true }), { headers: { "content-type": "application/json" } })))).rejects.toThrow(/truncated/i)
    await expect(fetchGithubCapabilityPack({ repositoryUrl: "https://github.com/o/r", commitSha: SHA, packPath: "pack" },
      vi.fn().mockResolvedValueOnce(commitResponse()).mockResolvedValueOnce(new Response(JSON.stringify({ tree: [{ path: "pack/a.md", type: "blob", sha: "x", size: 262145 }] }), { headers: { "content-type": "application/json" } })))).rejects.toThrow(/256 KiB/i)
    await expect(fetchGithubCapabilityPack({ repositoryUrl: "https://github.com/o/r", commitSha: SHA, packPath: "pack" },
      vi.fn().mockResolvedValueOnce(commitResponse()).mockResolvedValueOnce(new Response(JSON.stringify({ tree: [{ path: "pack/a.md", type: "blob", mode: "120000", sha: "x", size: 3 }] }), { headers: { "content-type": "application/json" } })))).rejects.toThrow(/symlink/i)
  })

  it("rejects a SHA that GitHub does not resolve as a commit", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: "Not Found" }), { status: 404, headers: { "content-type": "application/json" } }))
    await expect(fetchGithubCapabilityPack({ repositoryUrl: "https://github.com/o/r", commitSha: SHA, packPath: "pack" }, fetcher)).rejects.toThrow(/GitHub/i)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})
