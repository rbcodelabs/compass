import { describe, expect, it } from "vitest"
import { toInboxGroups } from "@/lib/notification-inbox"
import type { NotificationItem, NotificationPage } from "@/lib/notifications"

const item = (over: Partial<NotificationItem>): NotificationItem => ({
  id: "n1", kind: "STATUS_CHANGED", subjectType: "TASK", subjectId: "t1",
  actor: { type: "USER", id: "u", name: "Ada" }, payload: { from: "TODO", to: "DONE" },
  read: false, readAt: null, createdAt: new Date("2026-10-01T10:00:00Z"),
  subject: { title: "Ship it", path: "tasks/t1" }, ...over,
})

describe("toInboxGroups", () => {
  it("serializes dates, builds the sentence and links to the subject", () => {
    const first = item({})
    const page: NotificationPage = {
      items: [first], nextCursor: null,
      groups: [{ subjectType: "TASK", subjectId: "t1", subject: first.subject, unreadCount: 1, latestAt: first.createdAt, items: [first] }],
    }
    expect(toInboxGroups(page, "/acme/ws")).toEqual([{
      key: "TASK:t1", subjectType: "TASK", subjectLabel: "Task", title: "Ship it", href: "/acme/ws/tasks/t1", unreadCount: 1,
      latestAt: "2026-10-01T10:00:00.000Z",
      items: [{ id: "n1", actorName: "Ada", action: "changed status from Todo to Done", sentence: "Ada changed status from Todo to Done", read: false, createdAt: "2026-10-01T10:00:00.000Z" }],
    }])
    // Plain JSON: safe to hand to a client component.
    expect(JSON.parse(JSON.stringify(toInboxGroups(page, "/acme/ws")))).toEqual(toInboxGroups(page, "/acme/ws"))
  })

  it("keeps a group whose subject is gone, with no title or link, instead of dropping the row", () => {
    const gone = item({ subject: null })
    const page: NotificationPage = {
      items: [gone], nextCursor: null,
      groups: [{ subjectType: "TASK", subjectId: "t1", subject: null, unreadCount: 1, latestAt: gone.createdAt, items: [gone] }],
    }
    expect(toInboxGroups(page, "/acme/ws")[0]).toMatchObject({ title: null, href: null })
  })
})
