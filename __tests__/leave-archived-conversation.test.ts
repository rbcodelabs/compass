/** TASK-195 S2: after archiving, the panel returns to the previous crumb, or closes when there is none. */
import { describe, expect, it, vi } from "vitest"
import { leaveArchivedConversation } from "@/components/panels/leave-archived-conversation"

describe("leaveArchivedConversation", () => {
  it("jumps to the crumb before the current one", () => {
    const jumpToCrumb = vi.fn(), closePanel = vi.fn()
    leaveArchivedConversation({ historyStack: [{}, {}, {}], jumpToCrumb, closePanel })
    expect(jumpToCrumb).toHaveBeenCalledWith(1)
    expect(closePanel).not.toHaveBeenCalled()
  })
  it("closes the panel when the conversation is the only crumb", () => {
    const jumpToCrumb = vi.fn(), closePanel = vi.fn()
    leaveArchivedConversation({ historyStack: [{}], jumpToCrumb, closePanel })
    expect(closePanel).toHaveBeenCalledTimes(1)
    expect(jumpToCrumb).not.toHaveBeenCalled()
  })
})
