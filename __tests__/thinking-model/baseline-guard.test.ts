import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { assertBaselineCheckout } from "../../scripts/thinking-model-baseline-guard"

/** Real throwaway git repos, so the guard is tested against git itself, not a stub. */
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim()

let root: string
let repo: string
let first: string
let second: string

beforeAll(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "baseline-guard-"))
  repo = path.join(root, "repo")
  mkdirSync(repo)
  git(repo, "init", "-q", "-b", "main")
  writeFileSync(path.join(repo, "package.json"), "{}")
  git(repo, "add", "-A")
  git(repo, "commit", "-q", "-m", "one")
  first = git(repo, "rev-parse", "HEAD")
  writeFileSync(path.join(repo, "a.txt"), "a")
  git(repo, "add", "-A")
  git(repo, "commit", "-q", "-m", "two")
  second = git(repo, "rev-parse", "HEAD")
  git(repo, "update-ref", "refs/remotes/origin/main", second)
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

describe("assertBaselineCheckout", () => {
  it("accepts a clean checkout at origin/main and returns its sha", () => {
    expect(assertBaselineCheckout(repo)).toBe(second)
  })

  it("accepts a clean checkout at an ancestor of origin/main", () => {
    git(repo, "checkout", "-q", "--detach", first)
    try {
      expect(assertBaselineCheckout(repo)).toBe(first)
    } finally {
      git(repo, "checkout", "-q", "main")
    }
  })

  it("refuses a dirty checkout (modified or untracked source)", () => {
    writeFileSync(path.join(repo, "a.txt"), "changed")
    expect(() => assertBaselineCheckout(repo)).toThrow(/local changes/)
    git(repo, "checkout", "--", "a.txt")
    writeFileSync(path.join(repo, "stray.tsx"), "x")
    expect(() => assertBaselineCheckout(repo)).toThrow(/local changes/)
    rmSync(path.join(repo, "stray.tsx"))
    expect(assertBaselineCheckout(repo)).toBe(second)
  })

  it("refuses a HEAD that is ahead of origin/main or off to the side of it", () => {
    git(repo, "checkout", "-q", "-b", "feature")
    writeFileSync(path.join(repo, "b.txt"), "b")
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "feature work")
    try {
      expect(() => assertBaselineCheckout(repo)).toThrow(/neither origin\/main/)
    } finally {
      git(repo, "checkout", "-q", "main")
    }
  })

  it("refuses the feature branch (it contains lib/thinking-model)", () => {
    mkdirSync(path.join(repo, "lib/thinking-model"), { recursive: true })
    try {
      expect(() => assertBaselineCheckout(repo)).toThrow(/feature branch/)
    } finally {
      rmSync(path.join(repo, "lib"), { recursive: true, force: true })
    }
  })

  it("refuses a directory that is not a checkout, and a checkout with no origin/main", () => {
    expect(() => assertBaselineCheckout(path.join(root, "nowhere"))).toThrow(/not a checkout/)
    git(repo, "update-ref", "-d", "refs/remotes/origin/main")
    try {
      expect(() => assertBaselineCheckout(repo)).toThrow(/no origin\/main/)
    } finally {
      git(repo, "update-ref", "refs/remotes/origin/main", second)
    }
  })
})
