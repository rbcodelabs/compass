import { describe, expect, it } from "vitest"
import { gitAuthorEnv, gitAuthorInput, parseGitAuthor } from "@/lib/agent-git-author"

describe("agent git author", () => {
  it("accepts a valid pair and trims it", () => {
    expect(parseGitAuthor(" Rick ", " 1+rick@users.noreply.github.com ")).toEqual({ name: "Rick", email: "1+rick@users.noreply.github.com" })
  })
  it.each([[null, "a@b.co"], ["R", null], ["", "a@b.co"], ["R", "nope"], ["R\nx", "a@b.co"], ['R"', "a@b.co"], ["R", "a b@c.co"]])("rejects %j / %j", (n, e) => {
    expect(parseGitAuthor(n, e)).toBeNull()
  })
  it("treats both-empty as clear and half-set or invalid as an error", () => {
    expect(gitAuthorInput("", "  ")).toBeNull()
    expect(gitAuthorInput(null, undefined)).toBeNull()
    expect(() => gitAuthorInput("Rick", "")).toThrow(/both/)
    expect(() => gitAuthorInput("Rick", "bad")).toThrow(/not valid/)
  })
  it("maps to sandbox env only when set", () => {
    expect(gitAuthorEnv(null)).toEqual({})
    expect(gitAuthorEnv({ name: "R", email: "a@b.co" })).toEqual({ AGENT_GIT_AUTHOR_NAME: "R", AGENT_GIT_AUTHOR_EMAIL: "a@b.co" })
  })
})
