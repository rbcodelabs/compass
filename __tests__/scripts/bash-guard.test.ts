/**
 * The Bash guardrails for the GitHub-enabled agent shell (scripts/agent/bash-guard.ts).
 * They refuse the spellings of "push to the default branch", force-push, branch deletion,
 * merging, and rewriting the git config that enforces those. They are defense in depth:
 * the secrets boundary is the jail user, the enforcing control is branch protection.
 */
import { describe, expect, it } from "vitest"
import { checkBashCommand, parseCommandLine } from "../../scripts/agent/bash-guard"

const ok = (command: string) => expect(checkBashCommand(command), command).toEqual({ allowed: true })
const blocked = (command: string, reason?: RegExp) => {
  const decision = checkBashCommand(command)
  expect(decision.allowed, command).toBe(false)
  if (reason && !decision.allowed) expect(decision.reason).toMatch(reason)
}

describe("checkBashCommand: ordinary development work is allowed", () => {
  it("allows read-only and local git, shell basics and gh pr/repo reads", () => {
    for (const command of [
      "git clone --depth 1 https://github.com/rbcodelabs/compass.git",
      "cd compass && git log --oneline -5 && git status",
      "git switch -c agent/fix-typo && git add -A && git commit -m 'fix: typo'",
      "git diff origin/main...HEAD | head -50",
      "ls -la; cat README.md | grep -n compass",
      "gh pr view 12 --json title,state",
      "gh pr create --title 'Fix typo' --body 'Small fix' --base main",
      "gh repo view rbcodelabs/compass",
      "gh api repos/rbcodelabs/compass/pulls --method GET",
      "gh api repos/rbcodelabs/compass/contents/README.md",
      'grep -rn "git push" docs/ | head',
      "echo 'do not git push --force' > notes.txt",
      "curl -sS https://api.github.com/repos/rbcodelabs/compass",
      "git status 2>&1 | head",
    ]) ok(command)
  })

  it("allows pushing a named feature branch, with or without -u and HEAD:branch", () => {
    ok("git push -u origin agent/fix-typo")
    ok("git push origin agent/fix-typo")
    ok("git push origin HEAD:agent/fix-typo")
    ok("git push --set-upstream origin refs/heads/agent/x")
    ok("git -C compass push -u origin agent/y")
    ok("cd compass && git commit -am 'x' && git push -u origin agent/z")
  })
})

describe("checkBashCommand: pushes", () => {
  it("refuses a bare push (it may be on the default branch) and a push with no branch", () => {
    blocked("git push", /name the branch/)
    blocked("git push origin", /name the branch/)
    blocked("git push -u", /name the branch/)
  })

  it("refuses protected branches in every spelling", () => {
    for (const target of ["main", "master", "trunk", "develop", "release", "production", "refs/heads/main", "HEAD:main", "HEAD:refs/heads/master", "feature:main", "MAIN"]) {
      blocked(`git push origin ${target}`, /not allowed|protected/)
    }
    blocked("git push origin HEAD", /explicit/)
  })

  it("refuses force, delete, mirror, all, no-verify and + refspecs", () => {
    for (const command of [
      "git push --force origin agent/x",
      "git push -f origin agent/x",
      "git push origin agent/x --force",
      "git push --force-with-lease origin agent/x",
      "git push -fu origin agent/x",
      "git push origin +agent/x",
      "git push origin +HEAD:agent/x",
      "git push --delete origin agent/x",
      "git push -d origin agent/x",
      "git push origin :agent/x",
      "git push --mirror origin",
      "git push --all origin",
      "git push --no-verify origin agent/x",
      "git push https://github.com/other/repo.git agent/x",
      "git push git@github.com:other/repo.git agent/x",
      "git push origin 'refs/tags/v1'",
    ]) blocked(command)
  })

  it("sees through quoting, wrappers, chained commands and absolute paths", () => {
    blocked("g''it push origin main")
    blocked('"git" push "origin" "main"')
    blocked("env git push origin main")
    blocked("command git push --force origin agent/x")
    blocked("time nice -n 5 git push origin master")
    blocked("echo hi; git push origin main")
    blocked("cd x && git commit -m a && git push -f origin agent/x")
    blocked("git status | cat && git push origin main")
    blocked("/usr/bin/git push origin main")
  })
})

describe("checkBashCommand: hiding what runs", () => {
  it("refuses command substitution, expansion in command or subcommand position, eval, nested shells and xargs", () => {
    blocked("git push origin $(echo main)", /substitution/)
    blocked("git push origin `echo main`", /substitution/)
    blocked('git push origin "$(echo main)"', /substitution/)
    blocked("git push origin ${BRANCH}", /substitution/)
    blocked("$CMD push origin main", /expansion/)
    blocked("git $SUB origin main", /expansion/)
    blocked("git push origin $B", /expansion/)
    blocked("eval 'git push origin main'")
    blocked("bash -c 'git push origin main'", /nested shell/)
    blocked("sh -c 'git push origin main'")
    blocked("echo 'git push origin main' | xargs sh")
    blocked("echo main | xargs git push origin")
    blocked("sudo -n true")
    blocked("diff <(git show a) <(git show b)")
  })

  it("refuses environment and config overrides that change what git does", () => {
    blocked("GIT_DIR=/x git push origin agent/x", /GIT_DIR/)
    blocked("GIT_CONFIG_SYSTEM=/dev/null git push origin agent/x")
    blocked("env GIT_CONFIG_GLOBAL=/x git status")
    blocked("PATH=/tmp:/usr/bin git status")
    blocked("git -c core.hooksPath=/dev/null push origin agent/x", /-c/)
    blocked("git -c user.name=x commit -m a")
    blocked("git --git-dir=/tmp/x status")
    blocked("git config core.hooksPath /tmp/hooks", /configuration/)
    blocked("git config --global core.hooksPath /tmp/hooks")
    blocked("git config --local credential.helper '!echo'")
    blocked("git config url.https://evil/.insteadOf https://github.com/")
    blocked("git remote set-url origin https://evil.example/x.git", /remotes/)
    blocked("git remote add evil https://evil.example/x.git")
    blocked("git credential fill")
  })

  it("still lets the agent READ git configuration", () => {
    ok("git config --get user.name")
    ok("git config user.email")
    ok("git remote -v")
  })
})

describe("checkBashCommand: gh and raw HTTP", () => {
  it("allows only the gh surface the agent needs", () => {
    for (const command of [
      "gh release create v1",
      "gh secret set X",
      "gh workflow run ci.yml",
      "gh gist create f",
      "gh repo delete x/y --yes",
      "gh repo create x",
      "gh auth setup-git",
      "gh auth token",
      "gh extension install x",
      "gh alias set a b",
    ]) blocked(command)
  })

  it("refuses merging and a protected head branch", () => {
    blocked("gh pr merge 12", /not allowed/)
    blocked("gh pr create --head main --title t")
    blocked("gh pr create --head=owner:master --title t")
  })

  it("limits gh api to plain GET", () => {
    blocked("gh api -X PUT repos/o/r/contents/README.md")
    blocked("gh api --method=POST repos/o/r/issues")
    blocked("gh api -XDELETE repos/o/r/git/refs/heads/x")
    blocked("gh api repos/o/r/contents/x -f message=hi")
    blocked("gh api repos/o/r/contents/x -F content=@file")
    blocked("gh api repos/o/r/contents/x --input body.json")
    blocked("gh api graphql -f query='{viewer{login}}'")
    ok("gh api -X GET repos/o/r/pulls")
    ok("gh api --method GET repos/o/r/pulls")
  })

  it("refuses curl/wget writes to GitHub but not reads", () => {
    blocked("curl -X PUT -H 'Authorization: token x' https://api.github.com/repos/o/r/contents/f -d '{}'")
    blocked("curl -d @body https://api.github.com/repos/o/r/git/refs")
    blocked("curl --request POST https://api.github.com/repos/o/r/pulls")
    blocked("wget --post-data=x https://api.github.com/repos/o/r/issues")
    ok("curl -sSL https://codeload.github.com/o/r/tar.gz/main -o r.tgz")
  })
})

describe("checkBashCommand: malformed input fails closed", () => {
  it("refuses non-strings, empty, oversized, control characters and unterminated quotes", () => {
    for (const value of [undefined, null, 42, {}, "", "   ", "a".repeat(10_001), "git status\u0000", "echo 'unterminated"]) {
      expect(checkBashCommand(value).allowed).toBe(false)
    }
  })
})

describe("parseCommandLine", () => {
  it("dequotes words and splits on separators", () => {
    const parsed = parseCommandLine(`g''it "push" 'origin' a\\ b; echo "x y" && FOO=1 ls | wc`)
    expect(parsed.ok && parsed.commands.map((c) => c.words)).toEqual([["git", "push", "origin", "a b"], ["echo", "x y"], ["ls"], ["wc"]])
    expect(parsed.ok && parsed.commands[2].assignments).toEqual(["FOO=1"])
  })

  it("keeps a # inside a word and drops a trailing comment", () => {
    const parsed = parseCommandLine("echo a#b # git push origin main")
    expect(parsed.ok && parsed.commands).toEqual([{ words: ["echo", "a#b"], assignments: [] }])
  })
})
