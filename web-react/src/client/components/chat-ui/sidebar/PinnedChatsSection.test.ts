import { describe, expect, test } from "bun:test"
import type { SidebarChatRow } from "../../../../shared/types"
import { getPinnedChatsInUserOrder } from "./PinnedChatsSection"

function chat(chatId: string, pinnedOrder?: number): SidebarChatRow {
  return {
    _id: chatId,
    _creationTime: 1,
    chatId,
    title: chatId,
    status: "idle",
    unread: false,
    localPath: "/project",
    provider: null,
    hasAutomation: false,
    pinned: true,
    pinnedOrder,
  }
}

describe("getPinnedChatsInUserOrder", () => {
  test("uses the persisted pin rank instead of chat activity", () => {
    expect(getPinnedChatsInUserOrder([
      { ...chat("recent"), pinnedOrder: 10 },
      { ...chat("first"), pinnedOrder: 30 },
      { ...chat("not-pinned"), pinned: false },
    ]).map((item) => item.chatId)).toEqual(["first", "recent"])
  })
})
