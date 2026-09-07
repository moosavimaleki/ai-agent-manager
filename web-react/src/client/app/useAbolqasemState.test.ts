import { describe, expect, test } from "bun:test"
import {
  applySidebarProjectOrder,
  countMatchingUserPrompts,
  getActiveChatSnapshot,
  getActiveChatRefreshDelay,
  getComposerStateForActiveProvider,
  fetchFreshChatTranscript,
  getNextMeasuredInputHeight,
  getNewestRemainingChatId,
  getPreviousPrompt,
  getTranscriptPaddingBottom,
  getUiUpdateReadinessPath,
  getUserPromptSignature,
  isQueuedMessageNotFoundError,
  isTransportConnectionError,
  mergeOptimisticQueuedMessages,
  getUiUpdateRestartReconnectAction,
  normalizeChatSnapshot,
  reconcileOptimisticQueuedMessages,
  reconcileOptimisticUserPrompts,
  resolveComposeIntent,
  resolveProjectStartIntent,
  shouldEnqueueUserPrompt,
  shouldHandleUiUpdateReloadRequest,
  shouldMarkActiveChatRead,
  sameTranscriptEntries,
  shouldAutoFollowTranscript,
  ACTIVE_CHAT_REFRESH_INTERVAL_MS,
  BACKGROUND_CHAT_REFRESH_INTERVAL_MS,
  CHAT_HISTORY_PAGE_SIZE,
  INITIAL_CHAT_RECENT_LIMIT,
} from "./useAbolqasemState"
import type { ChatAttachment, ChatProviderPreferences, ChatSnapshot, QueuedChatMessage, SidebarData, UserPromptEntry } from "../../shared/types"

function createSidebarData(): SidebarData {
  return {
    projectGroups: [
      {
        groupKey: "project-1",
        title: "Project 1",
        realTitle: "Project 1",
        localPath: "/tmp/project-1",
        chats: [
          {
            _id: "row-1",
            _creationTime: 3,
            chatId: "chat-3",
            title: "Newest",
            status: "idle",
            unread: false,
            localPath: "/tmp/project-1",
            provider: null,
            lastMessageAt: 3,
            hasAutomation: false,
          },
          {
            _id: "row-2",
            _creationTime: 2,
            chatId: "chat-2",
            title: "Older",
            status: "idle",
            unread: false,
            localPath: "/tmp/project-1",
            provider: null,
            lastMessageAt: 2,
            hasAutomation: false,
          },
          {
            _id: "row-3",
            _creationTime: 1,
            chatId: "chat-1",
            title: "Oldest",
            status: "idle",
            unread: false,
            localPath: "/tmp/project-1",
            provider: null,
            lastMessageAt: 1,
            hasAutomation: false,
          },
        ],
        previewChats: [],
        olderChats: [],
        defaultCollapsed: false,
      },
      {
        groupKey: "project-2",
        title: "Project 2",
        realTitle: "Project 2",
        localPath: "/tmp/project-2",
        chats: [
          {
            _id: "row-4",
            _creationTime: 1,
            chatId: "chat-4",
            title: "Other project",
            status: "idle",
            unread: false,
            localPath: "/tmp/project-2",
            provider: null,
            lastMessageAt: 1,
            hasAutomation: false,
          },
        ],
        previewChats: [],
        olderChats: [],
        defaultCollapsed: true,
      },
    ],
  }
}

describe("getNewestRemainingChatId", () => {
  test("returns the next newest chat from the same project", () => {
    const sidebarData = createSidebarData()

    expect(getNewestRemainingChatId(sidebarData.projectGroups, "chat-3")).toBe("chat-2")
  })

  test("returns null when no other chats remain in the project", () => {
    const sidebarData = createSidebarData()

    expect(getNewestRemainingChatId(sidebarData.projectGroups, "chat-4")).toBeNull()
  })

  test("returns null when the chat is not found", () => {
    const sidebarData = createSidebarData()

    expect(getNewestRemainingChatId(sidebarData.projectGroups, "missing")).toBeNull()
  })
})

describe("isTransportConnectionError", () => {
  test("identifies transient socket failures that must not remain as chat errors", () => {
    expect(isTransportConnectionError("Disconnected")).toBe(true)
    expect(isTransportConnectionError("Request timed out; reconnecting to the local server")).toBe(true)
    expect(isTransportConnectionError("Socket disposed")).toBe(true)
  })

  test("keeps real command failures visible", () => {
    expect(isTransportConnectionError("Codex authentication failed")).toBe(false)
    expect(isTransportConnectionError(null)).toBe(false)
  })
})

describe("getComposerStateForActiveProvider", () => {
  const providerDefaults: ChatProviderPreferences = {
    claude: {
      model: "claude-sonnet-4-6",
      modelOptions: { reasoningEffort: "high", contextWindow: "200k" },
      planMode: false,
    },
    codex: {
      model: "gpt-5.5",
      modelOptions: { reasoningEffort: "low", fastMode: true },
      planMode: false,
    },
    opencode: {
      model: "opencode/nemotron-3.5-lightning-free",
      modelOptions: {},
      planMode: false,
    },
  }

  test("uses the runtime provider when local composer state is stale", () => {
    expect(getComposerStateForActiveProvider(
      {
        provider: "claude",
        model: "claude-sonnet-4-6",
        modelOptions: { reasoningEffort: "high", contextWindow: "200k" },
        planMode: true,
      },
      "codex",
      providerDefaults
    )).toEqual({
      provider: "codex",
      model: "gpt-5.5",
      modelOptions: { reasoningEffort: "low", fastMode: true },
      planMode: true,
    })
  })

  test("keeps OpenCode defaults when the runtime provider is OpenCode", () => {
    expect(getComposerStateForActiveProvider(
      {
        provider: "codex",
        model: "gpt-5.5",
        modelOptions: { reasoningEffort: "low", fastMode: true },
        planMode: true,
      },
      "opencode",
      providerDefaults,
    )).toEqual({
      provider: "opencode",
      model: "opencode/nemotron-3.5-lightning-free",
      modelOptions: {},
      planMode: true,
    })
  })
})

describe("applySidebarProjectOrder", () => {
  test("reorders project groups immediately using the optimistic order", () => {
    const sidebarData = createSidebarData()

    expect(
      applySidebarProjectOrder(sidebarData.projectGroups, ["project-2", "project-1"]).map((group) => group.groupKey)
    ).toEqual(["project-2", "project-1"])
  })

  test("keeps unspecified groups at the end and ignores unknown ids", () => {
    const sidebarData = createSidebarData()
    const reordered = applySidebarProjectOrder(sidebarData.projectGroups, ["missing", "project-2"])

    expect(reordered.map((group) => group.groupKey)).toEqual(["project-2", "project-1"])
  })

  test("returns the original array when the order already matches", () => {
    const sidebarData = createSidebarData()
    const reordered = applySidebarProjectOrder(sidebarData.projectGroups, ["project-1", "project-2"])

    expect(reordered).toBe(sidebarData.projectGroups)
  })
})

describe("shouldAutoFollowTranscript", () => {
  test("returns true when the transcript is at the bottom", () => {
    expect(shouldAutoFollowTranscript(0)).toBe(true)
  })

  test("returns true when the transcript is near the bottom", () => {
    expect(shouldAutoFollowTranscript(23)).toBe(true)
  })

  test("returns false when the transcript is not near the bottom", () => {
    expect(shouldAutoFollowTranscript(24)).toBe(false)
  })
})

describe("getTranscriptPaddingBottom", () => {
  test("keeps the extra bottom offset even when the input height is zero", () => {
    expect(getTranscriptPaddingBottom(0)).toBe(30)
  })

  test("adds the fixed offset to the measured input height", () => {
    expect(getTranscriptPaddingBottom(140)).toBe(170)
  })

  test("scales linearly as the composer grows", () => {
    expect(getTranscriptPaddingBottom(200) - getTranscriptPaddingBottom(140)).toBe(60)
  })
})

describe("getNextMeasuredInputHeight", () => {
  test("keeps the previous height when a transient zero measurement is reported", () => {
    expect(getNextMeasuredInputHeight(148, 0)).toBe(148)
  })

  test("accepts the latest non-zero measurement", () => {
    expect(getNextMeasuredInputHeight(148, 178)).toBe(178)
  })
})

describe("shouldMarkActiveChatRead", () => {
  test("returns true only when the page is visible and focused", () => {
    expect(shouldMarkActiveChatRead({
      visibilityState: "visible",
      hasFocus: () => true,
    })).toBe(true)

    expect(shouldMarkActiveChatRead({
      visibilityState: "hidden",
      hasFocus: () => true,
    })).toBe(false)

    expect(shouldMarkActiveChatRead({
      visibilityState: "visible",
      hasFocus: () => false,
    })).toBe(false)
  })
})

describe("getActiveChatRefreshDelay", () => {
  test("refreshes the selected browser tab every second and backs off hidden tabs", () => {
    expect(getActiveChatRefreshDelay({ visibilityState: "visible" })).toBe(ACTIVE_CHAT_REFRESH_INTERVAL_MS)
    expect(getActiveChatRefreshDelay({ visibilityState: "hidden" })).toBe(BACKGROUND_CHAT_REFRESH_INTERVAL_MS)
  })
})

describe("sameTranscriptEntries", () => {
  test("does not discard a native streaming update that keeps the same item id", () => {
    expect(sameTranscriptEntries(
      [{ _id: "response-1", kind: "assistant_text", text: "partial" }],
      [{ _id: "response-1", kind: "assistant_text", text: "partial output" }],
    )).toBe(false)
  })

  test("reuses an unchanged transcript snapshot", () => {
    expect(sameTranscriptEntries(
      [{ _id: "response-1", kind: "assistant_text", text: "complete" }],
      [{ _id: "response-1", kind: "assistant_text", text: "complete" }],
    )).toBe(true)
  })
})

describe("getUiUpdateRestartReconnectAction", () => {
  test("waits for server readiness after the socket disconnects", () => {
    expect(getUiUpdateRestartReconnectAction("awaiting_disconnect", "disconnected")).toBe("awaiting_server_ready")
  })

  test("does nothing for unrelated phase and connection combinations", () => {
    expect(getUiUpdateRestartReconnectAction(null, "connected")).toBe("none")
    expect(getUiUpdateRestartReconnectAction("awaiting_disconnect", "connected")).toBe("none")
    expect(getUiUpdateRestartReconnectAction("awaiting_server_ready", "disconnected")).toBe("none")
    expect(getUiUpdateRestartReconnectAction("awaiting_server_ready", "connected")).toBe("none")
  })
})

describe("shouldHandleUiUpdateReloadRequest", () => {
  test("handles a new backend reload request", () => {
    expect(shouldHandleUiUpdateReloadRequest(123, null)).toBe(true)
    expect(shouldHandleUiUpdateReloadRequest(123, "122")).toBe(true)
  })

  test("ignores missing or already handled reload requests", () => {
    expect(shouldHandleUiUpdateReloadRequest(null, null)).toBe(false)
    expect(shouldHandleUiUpdateReloadRequest(undefined, null)).toBe(false)
    expect(shouldHandleUiUpdateReloadRequest(123, "123")).toBe(false)
  })
})

describe("getUiUpdateReadinessPath", () => {
  test("uses a public auth endpoint so password-protected restarts can reload", () => {
    expect(getUiUpdateReadinessPath()).toBe("/auth/status")
  })
})

describe("resolveComposeIntent", () => {
  test("prefers the selected project when available", () => {
    expect(
      resolveComposeIntent({
        selectedProjectId: "project-selected",
        sidebarProjectId: "project-sidebar",
        fallbackLocalProjectPath: "/tmp/project",
      })
    ).toEqual({ kind: "project_id", projectId: "project-selected" })
  })

  test("falls back to the first sidebar project", () => {
    expect(
      resolveComposeIntent({
        selectedProjectId: null,
        sidebarProjectId: "project-sidebar",
        fallbackLocalProjectPath: "/tmp/project",
      })
    ).toEqual({ kind: "project_id", projectId: "project-sidebar" })
  })

  test("uses the first local project path when no project is selected", () => {
    expect(
      resolveComposeIntent({
        selectedProjectId: null,
        sidebarProjectId: null,
        fallbackLocalProjectPath: "/tmp/project",
      })
    ).toEqual({ kind: "local_path", localPath: "/tmp/project" })
  })

  test("returns null when no project target exists", () => {
    expect(
      resolveComposeIntent({
        selectedProjectId: null,
        sidebarProjectId: null,
        fallbackLocalProjectPath: null,
      })
    ).toBeNull()
  })
})

describe("resolveProjectStartIntent", () => {
  test("opens sidebar projects by local path so legacy groups get registered first", () => {
    const sidebarData = createSidebarData()

    expect(resolveProjectStartIntent(sidebarData.projectGroups, "project-1")).toEqual({
      kind: "local_path",
      localPath: "/tmp/project-1",
    })
  })

  test("falls back to project id when no sidebar path is known", () => {
    expect(resolveProjectStartIntent([], "project-missing")).toEqual({
      kind: "project_id",
      projectId: "project-missing",
    })
  })
})

describe("getActiveChatSnapshot", () => {
  test("returns the snapshot when it matches the active chat id", () => {
    const snapshot: ChatSnapshot = {
      runtime: {
        chatId: "chat-1",
        projectId: "project-1",
        localPath: "/tmp/project-1",
        title: "Chat 1",
        status: "idle",
        isDraining: false,
        provider: "codex",
        planMode: false,
        sessionToken: null,
      },
      queuedMessages: [],
      messages: [],
      history: {
        hasOlder: false,
        olderCursor: null,
        recentLimit: 200,
      },
      availableProviders: [],
    }

    expect(getActiveChatSnapshot(snapshot, "chat-1")).toEqual(snapshot)
  })

  test("returns null for a stale snapshot from a previous route", () => {
    const snapshot: ChatSnapshot = {
      runtime: {
        chatId: "chat-old",
        projectId: "project-1",
        localPath: "/tmp/project-1",
        title: "Old chat",
        status: "idle",
        isDraining: false,
        provider: "claude",
        planMode: false,
        sessionToken: null,
      },
      queuedMessages: [],
      messages: [],
      history: {
        hasOlder: false,
        olderCursor: null,
        recentLimit: 200,
      },
      availableProviders: [],
    }

    expect(getActiveChatSnapshot(snapshot, "chat-new")).toBeNull()
  })
})

describe("transcript startup budget", () => {
  test("keeps initial hydration and each history page bounded", () => {
    expect(INITIAL_CHAT_RECENT_LIMIT).toBe(50)
    expect(CHAT_HISTORY_PAGE_SIZE).toBe(100)
  })
})

describe("normalizeChatSnapshot", () => {
  test("coerces nullable server arrays to empty arrays", () => {
    const snapshot = {
      runtime: {
        chatId: "chat-1",
        projectId: "project-1",
        localPath: "/tmp/project-1",
        title: "Chat 1",
        status: "starting",
        isDraining: false,
        provider: "codex",
        planMode: false,
        sessionToken: null,
      },
      queuedMessages: null,
      messages: null,
      history: null,
      availableProviders: null,
    } as unknown as ChatSnapshot

    const normalized = normalizeChatSnapshot(snapshot)

    expect(normalized?.queuedMessages).toEqual([])
    expect(normalized?.messages).toEqual([])
    expect(normalized?.history).toEqual({
      hasOlder: false,
      olderCursor: null,
      recentLimit: INITIAL_CHAT_RECENT_LIMIT,
    })
    expect(normalized?.availableProviders).toEqual([])
  })

  test("coerces nullable queued message attachments to empty arrays", () => {
    const snapshot = {
      runtime: {
        chatId: "chat-1",
        projectId: "project-1",
        localPath: "/tmp/project-1",
        title: "Chat 1",
        status: "running",
        isDraining: false,
        provider: "codex",
        planMode: false,
        sessionToken: null,
      },
      queuedMessages: [{
        id: "queued-1",
        content: "follow up",
        attachments: null,
        createdAt: 1,
      }],
      messages: [],
      history: {
        hasOlder: false,
        olderCursor: null,
        recentLimit: 200,
      },
      availableProviders: [],
    } as unknown as ChatSnapshot

    const normalized = normalizeChatSnapshot(snapshot)

    expect(normalized?.queuedMessages).toEqual([{
      id: "queued-1",
      content: "follow up",
      attachments: [],
      createdAt: 1,
    }])
  })
})

describe("fetchFreshChatTranscript", () => {
  test("uses the local HTTP snapshot endpoint instead of the WebSocket", async () => {
    let requestedPath = ""
    let requestedMethod = ""
    const snapshot = {
      runtime: {
        chatId: "chat one",
        projectId: "project-1",
        localPath: "/tmp/project-1",
        title: "Chat 1",
        status: "idle",
        isDraining: false,
        provider: "codex",
        planMode: false,
        sessionToken: null,
      },
      queuedMessages: [],
      messages: [],
      history: { hasOlder: false, olderCursor: null, recentLimit: 50 },
      availableProviders: [],
    } as unknown as ChatSnapshot

    const result = await fetchFreshChatTranscript(snapshot.runtime.chatId, async (input, init) => {
      requestedPath = String(input)
      requestedMethod = init?.method ?? "GET"
      return new Response(JSON.stringify(snapshot), { status: 200 })
    })

    expect(requestedPath).toBe("/api/chats/chat%20one/refresh")
    expect(requestedMethod).toBe("POST")
    expect(result?.runtime.chatId).toBe(snapshot.runtime.chatId)
  })

  test("surfaces a failed local snapshot response to its caller", async () => {
    await expect(fetchFreshChatTranscript("chat-1", async () => new Response("offline", { status: 503 })))
      .rejects.toThrow("503")
  })
})

describe("shouldEnqueueUserPrompt", () => {
  test("queues a running app-server chat", () => {
    expect(shouldEnqueueUserPrompt("chat-1", true)).toBe(true)
  })

  test("does not queue idle chats", () => {
    expect(shouldEnqueueUserPrompt("chat-1", false)).toBe(false)
  })
})

describe("getPreviousPrompt", () => {
  test("returns the latest non-empty user prompt", () => {
    expect(getPreviousPrompt([
      {
        kind: "assistant_text",
        text: "hello",
        id: "assistant-1",
        timestamp: "2024-01-01T00:00:00.000Z",
      },
      {
        kind: "user_prompt",
        content: "first prompt",
        id: "user-1",
        timestamp: "2024-01-01T00:00:01.000Z",
      },
      {
        kind: "user_prompt",
        content: "   ",
        id: "user-2",
        timestamp: "2024-01-01T00:00:02.000Z",
      },
      {
        kind: "user_prompt",
        content: "second prompt",
        id: "user-3",
        timestamp: "2024-01-01T00:00:03.000Z",
      },
    ])).toBe("second prompt")
  })
})

describe("optimistic user prompts", () => {
  function createUserPrompt(
    id: string,
    content: string,
    attachments: ChatAttachment[] = [],
  ): UserPromptEntry {
    return {
      _id: id,
      createdAt: 1,
      kind: "user_prompt",
      content,
      attachments,
    }
  }

  test("counts matching prompts by content and attachments", () => {
    const attachment: ChatAttachment = {
      id: "att-1",
      kind: "file",
      displayName: "spec.txt",
      absolutePath: "/tmp/spec.txt",
      relativePath: "spec.txt",
      contentUrl: "/uploads/spec.txt",
      mimeType: "text/plain",
      size: 12,
    }
    const signature = getUserPromptSignature("Review this", [attachment])

    expect(countMatchingUserPrompts([
      createUserPrompt("msg-1", "Review this", [attachment]),
      createUserPrompt("msg-2", "Review this"),
    ], signature)).toBe(1)
  })

  test("reconciles duplicate optimistic prompts in order", () => {
    const optimisticPrompts = [
      {
        id: "opt-1",
        scopeId: "chat-1",
        signature: getUserPromptSignature("same"),
        requiredMatchCount: 1,
        contentMatchKey: "same",
        requiredContentMatchCount: 1,
        entry: createUserPrompt("optimistic:1", "same"),
      },
      {
        id: "opt-2",
        scopeId: "chat-1",
        signature: getUserPromptSignature("same"),
        requiredMatchCount: 2,
        contentMatchKey: "same",
        requiredContentMatchCount: 2,
        entry: createUserPrompt("optimistic:2", "same"),
      },
    ]

    expect(reconcileOptimisticUserPrompts(
      optimisticPrompts,
      "chat-1",
      [createUserPrompt("server-1", "same")],
    )).toEqual([optimisticPrompts[1]])
  })

  test("does not reconcile prompts from other chat scopes", () => {
    const optimisticPrompt = {
      id: "opt-1",
      scopeId: "chat-2",
      signature: getUserPromptSignature("same"),
      requiredMatchCount: 1,
      contentMatchKey: "same",
      requiredContentMatchCount: 1,
      entry: createUserPrompt("optimistic:1", "same"),
    }

    expect(reconcileOptimisticUserPrompts(
      [optimisticPrompt],
      "chat-1",
      [createUserPrompt("server-1", "same")],
    )).toEqual([optimisticPrompt])
  })

  test("reconciles an attached prompt after Codex expands pasted text into the user message", () => {
    const attachment: ChatAttachment = {
      id: "att-1",
      kind: "file",
      displayName: "pasted-text.txt",
      absolutePath: "/tmp/pasted-text.txt",
      relativePath: "pasted-text.txt",
      contentUrl: "/uploads/pasted-text.txt",
      mimeType: "text/plain",
      size: 5000,
    }
    const content = "عدد checkout چند بود؟"
    const optimisticPrompt = {
      id: "opt-attached",
      scopeId: "chat-1",
      signature: getUserPromptSignature(content, [attachment]),
      requiredMatchCount: 1,
      contentMatchKey: content,
      requiredContentMatchCount: 1,
      entry: createUserPrompt("optimistic:attached", content, [attachment]),
    }
    const expandedServerPrompt = `${content}\n\n[Attached text file: pasted-text.txt]\n\nlong file contents`

    expect(reconcileOptimisticUserPrompts(
      [optimisticPrompt],
      "chat-1",
      [createUserPrompt("server-1", expandedServerPrompt)],
    )).toEqual([])
  })
})

describe("optimistic queued messages", () => {
  test("shows a submitting message immediately and removes it when the server copy arrives", () => {
    const optimistic: QueuedChatMessage = {
      id: "queued-1",
      content: "ادامه بده",
      attachments: [],
      createdAt: 1,
      deliveryState: "submitting",
    }
    expect(mergeOptimisticQueuedMessages([], [{ scopeId: "chat-1", message: optimistic }], "chat-1")).toEqual([optimistic])

    const serverMessage = { ...optimistic, deliveryState: undefined }
    expect(mergeOptimisticQueuedMessages([serverMessage], [{ scopeId: "chat-1", message: optimistic }], "chat-1")).toEqual([optimistic])
    expect(reconcileOptimisticQueuedMessages(
      [{ scopeId: "chat-1", message: optimistic }],
      [serverMessage],
      "chat-1",
    )).toEqual([])
    expect(mergeOptimisticQueuedMessages([], [{ scopeId: "chat-2", message: optimistic }], "chat-1")).toEqual([])
  })

  test("coalesces the pre-ack optimistic row with the matching server row", () => {
    const optimistic: QueuedChatMessage = {
      id: "optimistic-queue:client-1",
      content: "ادامه بده",
      attachments: [],
      createdAt: 1_000,
      deliveryState: "steering",
    }
    const serverMessage: QueuedChatMessage = {
      ...optimistic,
      id: "queued-server-1",
      createdAt: 1_010,
      deliveryState: undefined,
    }

    expect(mergeOptimisticQueuedMessages(
      [serverMessage],
      [{ scopeId: "chat-1", message: optimistic, retainUntilSettled: true }],
      "chat-1",
    )).toEqual([{ ...serverMessage, deliveryState: "steering" }])
  })

  test("does not merge two intentional identical queued messages into one", () => {
    const first: QueuedChatMessage = { id: "optimistic-1", content: "ادامه بده", attachments: [], createdAt: 1_000, deliveryState: "submitting" }
    const second: QueuedChatMessage = { id: "optimistic-2", content: "ادامه بده", attachments: [], createdAt: 1_020, deliveryState: "submitting" }
    const serverMessage: QueuedChatMessage = { id: "server-1", content: "ادامه بده", attachments: [], createdAt: 1_010 }

    expect(mergeOptimisticQueuedMessages(
      [serverMessage],
      [
        { scopeId: "chat-1", message: first, retainUntilSettled: false },
        { scopeId: "chat-1", message: second, retainUntilSettled: false },
      ],
      "chat-1",
    )).toHaveLength(2)
  })
})

describe("queued command errors", () => {
  test("treats an already removed queue record as an idempotent completion", () => {
    expect(isQueuedMessageNotFoundError("queued message not found")).toBe(true)
    expect(isQueuedMessageNotFoundError("permission denied")).toBe(false)
  })
})
