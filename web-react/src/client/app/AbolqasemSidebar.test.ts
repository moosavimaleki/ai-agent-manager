import { describe, expect, test } from "bun:test"
import type { SidebarProjectGroup } from "../../shared/types"
import { getActiveSidebarChatLocation } from "./AbolqasemSidebar"

function group(
  groupKey: string,
  previewChatIds: string[],
  olderChatIds: string[],
): SidebarProjectGroup {
  const chat = (chatId: string) => ({
    _id: chatId,
    chatId,
    title: chatId,
    localPath: "/project",
    status: "idle" as const,
  })
  return {
    groupKey,
    title: groupKey,
    realTitle: groupKey,
    localPath: "/project",
    chats: [...previewChatIds, ...olderChatIds].map(chat),
    previewChats: previewChatIds.map(chat),
    olderChats: olderChatIds.map(chat),
  }
}

describe("getActiveSidebarChatLocation", () => {
  test("identifies a visible chat in its project", () => {
    expect(getActiveSidebarChatLocation([group("one", ["chat-1"], [])], "chat-1"))
      .toEqual({ groupKey: "one", isOlderChat: false })
  })

  test("identifies an older chat so its project page can be expanded before scrolling", () => {
    expect(getActiveSidebarChatLocation([group("one", ["chat-1"], ["chat-2"])], "chat-2"))
      .toEqual({ groupKey: "one", isOlderChat: true })
  })

  test("does not expand an unrelated project", () => {
    expect(getActiveSidebarChatLocation([group("one", ["chat-1"], [])], "chat-2")).toBeNull()
  })
})
