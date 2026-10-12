import { describe, expect, it } from "vitest"
import { describePackUpdate, mergeSkillSelection } from "@/lib/capability-pack-update"

describe("mergeSkillSelection", () => {
  it("keeps the admin's choice for skills present in both versions", () => {
    const result = mergeSkillSelection(
      { skills: [{ id: "a" }, { id: "b" }], enabledSkillIds: ["a"] },
      { skills: [{ id: "a" }, { id: "b" }] },
    )
    expect(result).toEqual(["a"])
  })
  it("does not re-enable a skill the admin turned off, even if it is default-on", () => {
    expect(mergeSkillSelection({ skills: [{ id: "a", enabledByDefault: true }], enabledSkillIds: [] }, { skills: [{ id: "a", enabledByDefault: true }] })).toEqual([])
  })
  it("applies defaults to skills that are new in the update", () => {
    const result = mergeSkillSelection(
      { skills: [{ id: "a" }], enabledSkillIds: ["a"] },
      { skills: [{ id: "a" }, { id: "on" }, { id: "explicit-on", enabledByDefault: true }, { id: "off", enabledByDefault: false }] },
    )
    expect(result).toEqual(["a", "explicit-on", "on"])
  })
  it("drops skills the update removed", () => {
    expect(mergeSkillSelection({ skills: [{ id: "a" }, { id: "gone" }], enabledSkillIds: ["a", "gone"] }, { skills: [{ id: "a" }] })).toEqual(["a"])
  })
})

describe("describePackUpdate", () => {
  it("flags an update only when the commits differ", () => {
    expect(describePackUpdate("a".repeat(40), "b".repeat(40)).updateAvailable).toBe(true)
    expect(describePackUpdate("a".repeat(40), "a".repeat(40)).updateAvailable).toBe(false)
  })
})
