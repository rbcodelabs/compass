/**
 * Guard for scripts/regenerate-thinking-model-baselines.ts: the CLASSIC baselines are evidence only if they come from
 * origin/main's own, unmodified components. A checkout is accepted when
 *   - it exists and does not contain lib/thinking-model (that would be the feature branch),
 *   - `git status --porcelain` is empty (no local edits or untracked source that could change what renders), and
 *   - its HEAD is origin/main or an ancestor of it (never a branch that is ahead of, or off to the side of, main).
 * Returns the checkout's HEAD sha, which the baseline records.
 */
import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import path from "node:path"

type Git = (args: string[], cwd: string) => string

const defaultGit: Git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim()

export function assertBaselineCheckout(checkout: string, git: Git = defaultGit): string {
  const main = path.resolve(checkout)
  if (!existsSync(path.join(main, "package.json"))) throw new Error(`${main} is not a checkout`)
  if (existsSync(path.join(main, "lib/thinking-model"))) {
    throw new Error(`${main} contains lib/thinking-model: that is the feature branch, not main. Use a checkout of origin/main.`)
  }
  const dirty = git(["status", "--porcelain"], main)
  if (dirty) throw new Error(`${main} has local changes; the baseline must come from a clean checkout of origin/main:\n${dirty}`)
  const head = git(["rev-parse", "HEAD"], main)
  let originMain: string
  try {
    originMain = git(["rev-parse", "origin/main"], main)
  } catch {
    throw new Error(`${main} has no origin/main ref to compare against; fetch it first`)
  }
  if (head !== originMain) {
    let ancestor = true
    try {
      git(["merge-base", "--is-ancestor", head, originMain], main)
    } catch {
      ancestor = false
    }
    if (!ancestor) throw new Error(`${main} is at ${head}, which is neither origin/main (${originMain}) nor an ancestor of it`)
  }
  return head
}
