import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { useNavigate } from "react-router-dom"
import { useShallow } from "zustand/react/shallow"
import { PROVIDERS, type AgentProvider, type ApprovalDecision, type AppSettingsPatch, type AppSettingsSnapshot, type AskUserQuestionAnswerMap, type ChatAttachment, type ChatConversionPreview, type ChatDiffSnapshot, type ChatHistoryPage, type ChatHistorySnapshot, type ChatProviderPreferences, type CheckpointRestoreMode, type CheckpointRestoreResult, type KeybindingsSnapshot, type LlmProviderSnapshot, type LlmProviderValidationResult, type ModelOptions, type ProviderCatalogEntry, type QueuedChatMessage, type TranscriptEntry, type UpdateInstallResult, type UpdateSnapshot, type UserPromptEntry } from "../../shared/types"
import { NEW_CHAT_COMPOSER_ID, type ComposerState, useChatPreferencesStore } from "../stores/chatPreferencesStore"
import { useRightSidebarStore } from "../stores/rightSidebarStore"
import { useTerminalLayoutStore } from "../stores/terminalLayoutStore"
import { getEditorPresetLabel, useTerminalPreferencesStore } from "../stores/terminalPreferencesStore"
import { useChatInputStore } from "../stores/chatInputStore"
import { useAppSettingsStore } from "../stores/appSettingsStore"
import { useChatSoundPreferencesStore } from "../stores/chatSoundPreferencesStore"
import type { ChatSnapshot, LocalProjectsSnapshot, SidebarChatRow, SidebarData } from "../../shared/types"
import type { AskUserQuestionItem } from "../components/messages/types"
import type { OpenLocalLinkTarget } from "../components/messages/shared"
import { useAppDialog } from "../components/ui/app-dialog"
import { useI18n } from "../i18n/context"
import { processTranscriptMessages } from "../lib/parseTranscript"
import { generateUUID } from "../lib/utils"
import { canCancelStatus, getLatestToolIds, isProcessingStatus } from "./derived"
import { AbolqasemSocket, type SocketStatus } from "./socket"
import { chatRoute } from "./routes"
import type { EditorOpenSettings, OpenExternalAction } from "../../shared/protocol"
import { RESTORE_CHAT_INPUT_FOCUS_EVENT } from "./chatFocusPolicy"

// A session can be receiving work in a separate Codex client. The hook stream
// delivers updates immediately when that client emits them; this lightweight
// refresh is the reliable fallback for in-progress transcript writes.
export const ACTIVE_CHAT_REFRESH_INTERVAL_MS = 1_000
export const BACKGROUND_CHAT_REFRESH_INTERVAL_MS = 15_000

export function getActiveChatRefreshDelay(doc: Pick<Document, "visibilityState"> = document) {
  return doc.visibilityState === "visible" ? ACTIVE_CHAT_REFRESH_INTERVAL_MS : BACKGROUND_CHAT_REFRESH_INTERVAL_MS
}

function sameRuntime(left: ChatSnapshot["runtime"] | null | undefined, right: ChatSnapshot["runtime"] | null | undefined) {
  if (left === right) return true
  if (!left || !right) return false
  return left.chatId === right.chatId
    && left.projectId === right.projectId
    && left.localPath === right.localPath
    && left.title === right.title
    && left.status === right.status
    && left.isDraining === right.isDraining
    && left.provider === right.provider
    && left.planMode === right.planMode
    && left.sessionToken === right.sessionToken
    && left.pendingForkSessionToken === right.pendingForkSessionToken
    && left.tmuxSession === right.tmuxSession
    && left.tmuxCommand === right.tmuxCommand
    && left.tmuxActive === right.tmuxActive
    && left.readOnly === right.readOnly
    && left.legacySessionKey === right.legacySessionKey
    && JSON.stringify(left.codexLock) === JSON.stringify(right.codexLock)
}

export function sameTranscriptEntries(left: ChatSnapshot["messages"] | null | undefined, right: ChatSnapshot["messages"] | null | undefined) {
  if (left === right) return true
  if (!left || !right) return false
  if (left.length !== right.length) return false
  return left.every((entry, index) => {
    const other = right[index]
    if (!other || entry._id !== other._id) return false
    // Native Codex writes streaming output by updating the existing item. Its
    // id is stable, so comparing ids alone made fresh snapshots look unchanged
    // and delayed the visible transcript until a later item was appended.
    return JSON.stringify(entry) === JSON.stringify(other)
  })
}

function sameProviders(left: ProviderCatalogEntry[] | null | undefined, right: ProviderCatalogEntry[] | null | undefined) {
  if (left === right) return true
  if (!left || !right) return false
  if (left.length !== right.length) return false
  return left.every((provider, index) => provider.id === right[index]?.id)
}

function sameHistory(left: ChatSnapshot["history"] | null | undefined, right: ChatSnapshot["history"] | null | undefined) {
  if (left === right) return true
  if (!left || !right) return false
  return left.hasOlder === right.hasOlder
    && left.olderCursor === right.olderCursor
    && left.recentLimit === right.recentLimit
}

function sameQueuedMessage(left: QueuedChatMessage, right: QueuedChatMessage) {
  return left.id === right.id
    && left.content === right.content
    && left.createdAt === right.createdAt
    && left.provider === right.provider
    && left.model === right.model
    && left.planMode === right.planMode
    && left.deliveryState === right.deliveryState
    && JSON.stringify(left.modelOptions) === JSON.stringify(right.modelOptions)
    && sameAttachmentArray(left.attachments, right.attachments)
}

function sameAttachmentArray(left: ChatAttachment[], right: ChatAttachment[]) {
  if (left === right) return true
  if (left.length !== right.length) return false
  return left.every((attachment, index) => {
    const other = right[index]
    return Boolean(other)
      && attachment.id === other.id
      && attachment.kind === other.kind
      && attachment.displayName === other.displayName
      && attachment.absolutePath === other.absolutePath
      && attachment.relativePath === other.relativePath
      && attachment.contentUrl === other.contentUrl
      && attachment.mimeType === other.mimeType
      && attachment.size === other.size
  })
}

function sameQueuedMessages(left: ChatSnapshot["queuedMessages"] | null | undefined, right: ChatSnapshot["queuedMessages"] | null | undefined) {
  if (left === right) return true
  if (!left || !right) return false
  if (left.length !== right.length) return false
  return left.every((message, index) => sameQueuedMessage(message, right[index]!))
}

function sameDiffs(left: ChatDiffSnapshot | null | undefined, right: ChatDiffSnapshot | null | undefined) {
  if (left === right) return true
  if (!left || !right) return false
  if (left.status !== right.status) return false
  if (left.branchName !== right.branchName) return false
  if (left.defaultBranchName !== right.defaultBranchName) return false
  if (left.hasOriginRemote !== right.hasOriginRemote) return false
  if (left.originRepoSlug !== right.originRepoSlug) return false
  if (left.hasUpstream !== right.hasUpstream) return false
  if (left.aheadCount !== right.aheadCount) return false
  if (left.behindCount !== right.behindCount) return false
  if (left.lastFetchedAt !== right.lastFetchedAt) return false
  const leftHistory = left.branchHistory?.entries ?? []
  const rightHistory = right.branchHistory?.entries ?? []
  if (leftHistory.length !== rightHistory.length) return false
  const sameBranchHistory = leftHistory.every((entry, index) => {
    const other = rightHistory[index]
    return Boolean(other)
      && entry.sha === other.sha
      && entry.summary === other.summary
      && entry.description === other.description
      && entry.authorName === other.authorName
      && entry.authoredAt === other.authoredAt
      && entry.githubUrl === other.githubUrl
      && entry.tags.length === other.tags.length
      && entry.tags.every((tag, tagIndex) => tag === other.tags[tagIndex])
  })
  if (!sameBranchHistory) return false
  const leftCheckpoints = left.checkpoints ?? []
  const rightCheckpoints = right.checkpoints ?? []
  if (leftCheckpoints.length !== rightCheckpoints.length) return false
  const sameCheckpoints = leftCheckpoints.every((checkpoint, index) => {
    const other = rightCheckpoints[index]
    return Boolean(other)
      && checkpoint.id === other.id
      && checkpoint.chatId === other.chatId
      && checkpoint.projectId === other.projectId
      && checkpoint.title === other.title
      && checkpoint.createdAt === other.createdAt
      && checkpoint.trigger === other.trigger
      && checkpoint.promptPreview === other.promptPreview
      && checkpoint.restoreOf === other.restoreOf
      && checkpoint.codeKind === other.codeKind
      && checkpoint.codeStatus === other.codeStatus
      && checkpoint.codeWarning === other.codeWarning
      && checkpoint.branchName === other.branchName
      && checkpoint.commit === other.commit
      && checkpoint.fileCount === other.fileCount
      && checkpoint.chatMessageCount === other.chatMessageCount
  })
  if (!sameCheckpoints) return false
  if (left.files.length !== right.files.length) return false
  return left.files.every((file, index) => {
    const other = right.files[index]
    return Boolean(other)
      && file.path === other.path
      && file.changeType === other.changeType
      && file.isUntracked === other.isUntracked
      && file.additions === other.additions
      && file.deletions === other.deletions
      && file.patchDigest === other.patchDigest
      && file.mimeType === other.mimeType
      && file.size === other.size
  })
}

function shouldPreserveExistingProjectDiffs(
  current: ChatDiffSnapshot | null | undefined,
  next: ChatDiffSnapshot | null | undefined
) {
  return Boolean(
    current
    && current.status !== "unknown"
    && next
    && next.status === "unknown"
    && next.files.length === 0
  )
}

function sameChatSnapshotCore(left: ChatSnapshot | null, right: ChatSnapshot | null) {
  if (left === right) return true
  if (!left || !right) return false
  return sameRuntime(left.runtime, right.runtime)
    && sameQueuedMessages(left.queuedMessages, right.queuedMessages)
    && sameTranscriptEntries(left.messages, right.messages)
    && sameHistory(left.history, right.history)
    && sameProviders(left.availableProviders, right.availableProviders)
}

function mergeTranscriptEntries(olderHistoryEntries: TranscriptEntry[], recentEntries: TranscriptEntry[]) {
  const deduped = new Map<string, TranscriptEntry>()
  for (const entry of olderHistoryEntries) {
    deduped.set(entry._id, entry)
  }
  for (const entry of recentEntries) {
    deduped.set(entry._id, entry)
  }
  return [...deduped.values()]
}

export function getPreviousPrompt(messages: ReturnType<typeof processTranscriptMessages>) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.kind === "user_prompt" && message.content.trim().length > 0) {
      return message.content
    }
  }
  return null
}

const NEW_CHAT_OPTIMISTIC_SCOPE = "__new_chat__"
const LEGACY_THEME_STORAGE_KEY = "lever-theme"
const LEGACY_CHAT_SOUND_STORAGE_KEY = "chat-sound-preferences"
const LEGACY_TERMINAL_STORAGE_KEY = "terminal-preferences"
const LEGACY_CHAT_PREFERENCES_STORAGE_KEY = "chat-preferences"

export interface OptimisticUserPrompt {
  id: string
  scopeId: string
  signature: string
  requiredMatchCount: number
  contentMatchKey: string
  requiredContentMatchCount: number
  entry: UserPromptEntry
}

interface OptimisticQueuedMessage {
  scopeId: string
  message: QueuedChatMessage
  retainUntilSettled?: boolean
}

const OPTIMISTIC_QUEUE_MATCH_WINDOW_MS = 60_000

function queuedMessagesReferToSameSubmission(left: QueuedChatMessage, right: QueuedChatMessage) {
  if (left.id === right.id) return true
  if (Math.abs(left.createdAt - right.createdAt) > OPTIMISTIC_QUEUE_MATCH_WINDOW_MS) return false
  return getUserPromptSignature(left.content, left.attachments) === getUserPromptSignature(right.content, right.attachments)
}

function pairQueuedMessages(
  serverMessages: QueuedChatMessage[],
  optimisticMessages: OptimisticQueuedMessage[],
) {
  const usedOptimisticIndexes = new Set<number>()
  const optimisticIndexByServerIndex = new Map<number, number>()
  for (let serverIndex = 0; serverIndex < serverMessages.length; serverIndex += 1) {
    const serverMessage = serverMessages[serverIndex]!
    let matchIndex = optimisticMessages.findIndex((item, index) => (
      !usedOptimisticIndexes.has(index) && item.message.id === serverMessage.id
    ))
    if (matchIndex < 0) {
      let closestDelta = Number.POSITIVE_INFINITY
      optimisticMessages.forEach((item, index) => {
        if (usedOptimisticIndexes.has(index) || !queuedMessagesReferToSameSubmission(serverMessage, item.message)) return
        const delta = Math.abs(serverMessage.createdAt - item.message.createdAt)
        if (delta < closestDelta) {
          matchIndex = index
          closestDelta = delta
        }
      })
    }
    if (matchIndex >= 0) {
      usedOptimisticIndexes.add(matchIndex)
      optimisticIndexByServerIndex.set(serverIndex, matchIndex)
    }
  }
  return { optimisticIndexByServerIndex, usedOptimisticIndexes }
}

export function mergeOptimisticQueuedMessages(
  serverMessages: QueuedChatMessage[],
  optimisticMessages: OptimisticQueuedMessage[],
  scopeId: string,
): QueuedChatMessage[] {
  const scopedOptimisticMessages = optimisticMessages.filter((item) => item.scopeId === scopeId)
  const { optimisticIndexByServerIndex, usedOptimisticIndexes } = pairQueuedMessages(serverMessages, scopedOptimisticMessages)
  return [
    ...serverMessages.map((message, index) => {
      const optimisticIndex = optimisticIndexByServerIndex.get(index)
      if (optimisticIndex === undefined) return message
      const optimistic = scopedOptimisticMessages[optimisticIndex]!.message
      return optimistic.deliveryState
        ? { ...message, deliveryState: optimistic.deliveryState }
        : message
    }),
    ...scopedOptimisticMessages
      .filter((_, index) => !usedOptimisticIndexes.has(index))
      .map((item) => item.message),
  ]
}

export function reconcileOptimisticQueuedMessages(
  optimisticMessages: OptimisticQueuedMessage[],
  serverMessages: QueuedChatMessage[],
  scopeId: string,
) {
  const scopedOptimisticMessages = optimisticMessages.filter((item) => item.scopeId === scopeId)
  const { usedOptimisticIndexes } = pairQueuedMessages(serverMessages, scopedOptimisticMessages)
  let scopedIndex = 0
  return optimisticMessages.filter((item) => {
    if (item.scopeId !== scopeId) return true
    const matched = usedOptimisticIndexes.has(scopedIndex)
    scopedIndex += 1
    return !matched || Boolean(item.retainUntilSettled)
  })
}

interface OptimisticProcessingState {
  scopeId: string
  ackedAt: number | null
}

function readPersistedZustandState(key: string): Record<string, unknown> | null {
  if (typeof window === "undefined") return null
  const raw = window.localStorage.getItem(key)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as { state?: unknown }
    return parsed.state && typeof parsed.state === "object" && !Array.isArray(parsed.state)
      ? parsed.state as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function readLegacyBrowserSettingsPatch(): AppSettingsPatch | null {
  if (typeof window === "undefined") return null

  const patch: AppSettingsPatch = {}
  const theme = window.localStorage.getItem(LEGACY_THEME_STORAGE_KEY)
  if (theme === "light" || theme === "dark" || theme === "system") {
    patch.theme = theme
  }

  const chatSoundState = readPersistedZustandState(LEGACY_CHAT_SOUND_STORAGE_KEY)
  if (chatSoundState?.chatSoundPreference === "never" || chatSoundState?.chatSoundPreference === "unfocused" || chatSoundState?.chatSoundPreference === "always") {
    patch.chatSoundPreference = chatSoundState.chatSoundPreference
  }
  if (
    chatSoundState?.chatSoundId === "blow"
    || chatSoundState?.chatSoundId === "bottle"
    || chatSoundState?.chatSoundId === "frog"
    || chatSoundState?.chatSoundId === "funk"
    || chatSoundState?.chatSoundId === "glass"
    || chatSoundState?.chatSoundId === "ping"
    || chatSoundState?.chatSoundId === "pop"
    || chatSoundState?.chatSoundId === "purr"
    || chatSoundState?.chatSoundId === "tink"
  ) {
    patch.chatSoundId = chatSoundState.chatSoundId
  }

  const terminalState = readPersistedZustandState(LEGACY_TERMINAL_STORAGE_KEY)
  if (terminalState) {
    patch.terminal = {}
    if (typeof terminalState.scrollbackLines === "number") {
      patch.terminal.scrollbackLines = terminalState.scrollbackLines
    }
    if (typeof terminalState.minColumnWidth === "number") {
      patch.terminal.minColumnWidth = terminalState.minColumnWidth
    }
    const editorPatch: NonNullable<AppSettingsPatch["editor"]> = {}
    if (
      terminalState.editorPreset === "cursor"
      || terminalState.editorPreset === "vscode"
      || terminalState.editorPreset === "xcode"
      || terminalState.editorPreset === "windsurf"
      || terminalState.editorPreset === "custom"
    ) {
      editorPatch.preset = terminalState.editorPreset
    }
    if (typeof terminalState.editorCommandTemplate === "string") {
      editorPatch.commandTemplate = terminalState.editorCommandTemplate
    }
    if (Object.keys(editorPatch).length > 0) {
      patch.editor = editorPatch
    }
  }

  const chatPreferencesState = readPersistedZustandState(LEGACY_CHAT_PREFERENCES_STORAGE_KEY)
  if (
    chatPreferencesState?.defaultProvider === "last_used"
    || chatPreferencesState?.defaultProvider === "claude"
    || chatPreferencesState?.defaultProvider === "codex"
  ) {
    patch.defaultProvider = chatPreferencesState.defaultProvider
  }
  if (chatPreferencesState?.providerDefaults && typeof chatPreferencesState.providerDefaults === "object") {
    patch.providerDefaults = chatPreferencesState.providerDefaults as AppSettingsPatch["providerDefaults"]
  }

  patch.browserSettingsMigrated = true
  return Object.keys(patch).length > 1 ? patch : null
}

function clearLegacyBrowserSettings() {
  if (typeof window === "undefined") return
  window.localStorage.removeItem(LEGACY_THEME_STORAGE_KEY)
  window.localStorage.removeItem(LEGACY_CHAT_SOUND_STORAGE_KEY)
  window.localStorage.removeItem(LEGACY_TERMINAL_STORAGE_KEY)
  window.localStorage.removeItem(LEGACY_CHAT_PREFERENCES_STORAGE_KEY)
}

function syncRuntimeStoresFromAppSettings(snapshot: AppSettingsSnapshot) {
  useAppSettingsStore.getState().setFromServer(snapshot)
  const terminalPreferences = useTerminalPreferencesStore.getState()
  terminalPreferences.setScrollbackLines(snapshot.terminal.scrollbackLines)
  terminalPreferences.setMinColumnWidth(snapshot.terminal.minColumnWidth)
  terminalPreferences.setEditorPreset(snapshot.editor.preset)
  terminalPreferences.setEditorCommandTemplate(snapshot.editor.commandTemplate)

  const chatSoundPreferences = useChatSoundPreferencesStore.getState()
  chatSoundPreferences.setChatSoundPreference(snapshot.chatSoundPreference)
  chatSoundPreferences.setChatSoundId(snapshot.chatSoundId)

  useChatPreferencesStore.getState().syncProviderDefaults(snapshot.defaultProvider, snapshot.providerDefaults)
}

function serializeAttachmentSignature(attachment: ChatAttachment) {
  return JSON.stringify({
    id: attachment.id,
    kind: attachment.kind,
    displayName: attachment.displayName,
    relativePath: attachment.relativePath,
    mimeType: attachment.mimeType,
    size: attachment.size,
    contentUrl: attachment.contentUrl,
  })
}

export function getUserPromptSignature(content: string, attachments: ChatAttachment[] = []) {
  return JSON.stringify({
    content,
    attachments: attachments.map(serializeAttachmentSignature),
  })
}

export function getUserPromptContentMatchKey(content: string) {
  const normalized = content.trim()
  const attachmentMarkers = ["\n\n[Attached text file:", "\n[Attached text file:"]
  let end = normalized.length
  for (const marker of attachmentMarkers) {
    const index = normalized.indexOf(marker)
    if (index >= 0 && index < end) end = index
  }
  return normalized.slice(0, end).trim()
}

export function countMatchingUserPromptContent(entries: TranscriptEntry[], contentMatchKey: string) {
  if (!contentMatchKey) return 0
  return entries.reduce((count, entry) => {
    if (entry.kind !== "user_prompt") return count
    return count + (getUserPromptContentMatchKey(entry.content) === contentMatchKey ? 1 : 0)
  }, 0)
}

export function countMatchingUserPrompts(entries: TranscriptEntry[], signature: string) {
  return entries.reduce((count, entry) => {
    if (entry.kind !== "user_prompt") return count
    return count + (getUserPromptSignature(entry.content, entry.attachments ?? []) === signature ? 1 : 0)
  }, 0)
}

export function reconcileOptimisticUserPrompts(
  optimisticPrompts: OptimisticUserPrompt[],
  scopeId: string,
  serverEntries: TranscriptEntry[],
) {
  const matchCounts = new Map<string, number>()
  const contentMatchCounts = new Map<string, number>()
  for (const entry of serverEntries) {
    if (entry.kind !== "user_prompt") continue
    const signature = getUserPromptSignature(entry.content, entry.attachments ?? [])
    matchCounts.set(signature, (matchCounts.get(signature) ?? 0) + 1)
    const contentMatchKey = getUserPromptContentMatchKey(entry.content)
    if (contentMatchKey) {
      contentMatchCounts.set(contentMatchKey, (contentMatchCounts.get(contentMatchKey) ?? 0) + 1)
    }
  }

  return optimisticPrompts.filter((prompt) => {
    if (prompt.scopeId !== scopeId) return true
    if ((matchCounts.get(prompt.signature) ?? 0) >= prompt.requiredMatchCount) return false
    return (contentMatchCounts.get(prompt.contentMatchKey) ?? 0) < prompt.requiredContentMatchCount
  })
}

// Startup must stay bounded as a conversation grows. Rendering a whole
// transcript is CPU-bound (message hydration, markdown and tool cards), so a
// large fixed tail makes the app slower every day even when the WebSocket is
// fast. Older messages remain available through the existing history control.
export const INITIAL_CHAT_RECENT_LIMIT = 50
export const CHAT_HISTORY_PAGE_SIZE = 100

type RuntimeChatSnapshot = Omit<ChatSnapshot, "queuedMessages" | "messages" | "history" | "availableProviders"> & {
  queuedMessages?: ChatSnapshot["queuedMessages"] | null
  messages?: ChatSnapshot["messages"] | null
  history?: ChatHistorySnapshot | null
  availableProviders?: ChatSnapshot["availableProviders"] | null
}

type RuntimeQueuedChatMessage = Omit<QueuedChatMessage, "attachments"> & {
  attachments?: QueuedChatMessage["attachments"] | null
}

function normalizeQueuedMessages(value: ChatSnapshot["queuedMessages"] | null | undefined): QueuedChatMessage[] {
  if (!Array.isArray(value)) return []

  let changed = false
  const normalized = value.map((message) => {
    const runtimeMessage = message as RuntimeQueuedChatMessage
    if (Array.isArray(runtimeMessage.attachments)) {
      return message
    }
    changed = true
    return {
      ...message,
      attachments: [],
    }
  })

  return changed ? normalized : value
}

export function normalizeChatSnapshot(snapshot: ChatSnapshot | null): ChatSnapshot | null {
  if (!snapshot) return null

  const runtimeSnapshot = snapshot as RuntimeChatSnapshot
  const queuedMessages = normalizeQueuedMessages(runtimeSnapshot.queuedMessages)
  const messages = Array.isArray(runtimeSnapshot.messages) ? runtimeSnapshot.messages : []
  const history = runtimeSnapshot.history ?? {
    hasOlder: false,
    olderCursor: null,
    recentLimit: INITIAL_CHAT_RECENT_LIMIT,
  }
  const availableProviders = Array.isArray(runtimeSnapshot.availableProviders) ? runtimeSnapshot.availableProviders : []

  if (
    queuedMessages === runtimeSnapshot.queuedMessages
    && messages === runtimeSnapshot.messages
    && history === runtimeSnapshot.history
    && availableProviders === runtimeSnapshot.availableProviders
  ) {
    return snapshot
  }

  return {
    ...snapshot,
    queuedMessages,
    messages,
    history,
    availableProviders,
  }
}

export async function fetchFreshChatTranscript(
  chatId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ChatSnapshot | null> {
  const response = await fetchImpl(
    `/api/chats/${encodeURIComponent(chatId)}/refresh`,
    {
      method: "POST",
      headers: { Accept: "application/json" },
    },
  )
  if (!response.ok) {
    throw new Error(`Chat transcript refresh failed with status ${response.status}`)
  }
  return normalizeChatSnapshot((await response.json()) as ChatSnapshot | null)
}

export function shouldEnqueueUserPrompt(activeChatId: string | null, isProcessing: boolean) {
	return Boolean(activeChatId && isProcessing)
}

export function getNewestRemainingChatId(projectGroups: SidebarData["projectGroups"], activeChatId: string): string | null {
  const projectGroup = projectGroups.find((group) => group.chats.some((chat) => chat.chatId === activeChatId))
  if (!projectGroup) return null

  return projectGroup.chats.find((chat) => chat.chatId !== activeChatId)?.chatId ?? null
}

export function applySidebarProjectOrder(
  projectGroups: SidebarData["projectGroups"],
  projectIds: string[] | null | undefined
) {
  if (!projectIds?.length || projectGroups.length <= 1) {
    return projectGroups
  }

  const indexByProjectId = new Map(projectGroups.map((group, index) => [group.groupKey, index]))
  const seen = new Set<string>()
  const orderedGroups = projectIds
    .map((projectId) => {
      if (seen.has(projectId)) {
        return null
      }
      seen.add(projectId)
      const index = indexByProjectId.get(projectId)
      return index === undefined ? null : projectGroups[index]
    })
    .filter((group): group is SidebarData["projectGroups"][number] => Boolean(group))

  if (orderedGroups.length === 0) {
    return projectGroups
  }

  const nextProjectGroups = [
    ...orderedGroups,
    ...projectGroups.filter((group) => !seen.has(group.groupKey)),
  ]

  return nextProjectGroups.every((group, index) => group === projectGroups[index])
    ? projectGroups
    : nextProjectGroups
}

export function shouldMarkActiveChatRead(doc: Pick<Document, "visibilityState" | "hasFocus"> = document) {
  return doc.visibilityState === "visible" && doc.hasFocus()
}

function wsUrl() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:"
  return `${protocol}//${window.location.host}/ws`
}

function useAbolqasemSocket() {
  const socketRef = useRef<AbolqasemSocket | null>(null)
  if (!socketRef.current) {
    socketRef.current = new AbolqasemSocket(wsUrl())
  }

  useEffect(() => {
    const socket = socketRef.current
    socket?.start()
    return () => {
      socket?.dispose()
    }
  }, [])

  return socketRef.current as AbolqasemSocket
}

function logAbolqasemState(message: string, details?: unknown) {
  void message
  void details
}

const SEND_TO_STARTING_PROFILE_STORAGE_KEY = "abolqasem:profile-send-to-starting"

interface SendToStartingTrace {
  traceId: string
  optimisticId: string
  startedAt: number
  serverChatId: string | null
  routeChatIdAtSend: string | null
  contentPreview: string
  ackAt?: number
  snapshotAt?: number
  startingStatusAt?: number
  startingRenderedAt?: number
}

function isSendToStartingProfilingEnabled() {
  try {
    return window.sessionStorage.getItem(SEND_TO_STARTING_PROFILE_STORAGE_KEY) === "1"
      || window.localStorage.getItem(SEND_TO_STARTING_PROFILE_STORAGE_KEY) === "1"
  } catch {
    return false
  }
}

function elapsedTraceMs(startedAt: number) {
  return Number((performance.now() - startedAt).toFixed(1))
}

function logSendToStartingTrace(
  trace: SendToStartingTrace | null | undefined,
  stage: string,
  details?: Record<string, unknown>
) {
  if (!trace || !isSendToStartingProfilingEnabled()) {
    return
  }

  console.debug("[abolqasem/send->starting][client]", {
    traceId: trace.traceId,
    stage,
    elapsedMs: elapsedTraceMs(trace.startedAt),
    serverChatId: trace.serverChatId,
    routeChatIdAtSend: trace.routeChatIdAtSend,
    ...details,
  })
}

function composerStateFromSendOptions(options?: {
  provider?: AgentProvider
  model?: string
  modelOptions?: ModelOptions
  planMode?: boolean
}): ComposerState | null {
  if (options?.provider === "claude" && options.model && options.modelOptions?.claude) {
    return {
      provider: "claude",
      model: options.model,
      modelOptions: {
        reasoningEffort: options.modelOptions.claude.reasoningEffort ?? "high",
        contextWindow: options.modelOptions.claude.contextWindow ?? "200k",
      },
      planMode: Boolean(options.planMode),
    }
  }

  if (options?.provider === "codex" && options.model && options.modelOptions?.codex) {
    return {
      provider: "codex",
      model: options.model,
      modelOptions: {
        reasoningEffort: options.modelOptions.codex.reasoningEffort ?? "high",
        fastMode: options.modelOptions.codex.fastMode ?? false,
      },
      planMode: Boolean(options.planMode),
    }
  }

  if (options?.provider === "opencode" && options.model) {
    return {
      provider: "opencode",
      model: options.model,
      modelOptions: { ...options.modelOptions?.opencode },
      planMode: Boolean(options.planMode),
    }
  }

  return null
}

export function getComposerStateForActiveProvider(
  composerState: ComposerState,
  activeProvider: AgentProvider | null,
  providerDefaults: ChatProviderPreferences
): ComposerState {
  if (!activeProvider || composerState.provider === activeProvider) {
    return composerState
  }

  if (activeProvider === "claude") {
    return {
      provider: "claude",
      model: providerDefaults.claude.model,
      modelOptions: { ...providerDefaults.claude.modelOptions },
      planMode: composerState.planMode,
    }
  }

  if (activeProvider === "opencode") {
    return {
      provider: "opencode",
      model: providerDefaults.opencode.model,
      modelOptions: { ...providerDefaults.opencode.modelOptions },
      planMode: composerState.planMode,
    }
  }

  return {
    provider: "codex",
    model: providerDefaults.codex.model,
    modelOptions: { ...providerDefaults.codex.modelOptions },
    planMode: composerState.planMode,
  }
}

function getProjectIdForChat(projectGroups: SidebarData["projectGroups"], chatId: string | null) {
  if (!chatId) return null
  return projectGroups.find((group) => group.chats.some((chat) => chat.chatId === chatId))?.groupKey ?? null
}

export function shouldAutoFollowTranscript(distanceFromBottom: number) {
  return distanceFromBottom < 24
}

export function getUiUpdateRestartReconnectAction(
  phase: string | null,
  connectionStatus: SocketStatus
): "none" | "awaiting_server_ready" {
  if (phase === "awaiting_disconnect" && connectionStatus === "disconnected") {
    return "awaiting_server_ready"
  }

  return "none"
}

export function isTransportConnectionError(message: string | null | undefined) {
  const normalized = message?.trim().toLowerCase()
  return normalized === "disconnected"
    || normalized === "socket disposed"
    || normalized?.startsWith("request timed out") === true
}

export function isQueuedMessageNotFoundError(message: string | null | undefined) {
  return message?.trim().toLowerCase() === "queued message not found"
}

export const TRANSCRIPT_PADDING_BOTTOM_OFFSET = 30
const UI_UPDATE_RESTART_STORAGE_KEY = "abolqasem:ui-update-restart"
const UI_UPDATE_RELOAD_REQUEST_STORAGE_KEY = "abolqasem:last-update-reload-request"

export function getTranscriptPaddingBottom(inputHeight: number) {
  return inputHeight + TRANSCRIPT_PADDING_BOTTOM_OFFSET
}

export function getNextMeasuredInputHeight(previousHeight: number, measuredHeight: number) {
  return measuredHeight > 0 ? measuredHeight : previousHeight
}

function getUiUpdateRestartPhase() {
  return window.sessionStorage.getItem(UI_UPDATE_RESTART_STORAGE_KEY)
}

function setUiUpdateRestartPhase(phase: "awaiting_disconnect" | "awaiting_server_ready") {
  window.sessionStorage.setItem(UI_UPDATE_RESTART_STORAGE_KEY, phase)
}

function clearUiUpdateRestartPhase() {
  window.sessionStorage.removeItem(UI_UPDATE_RESTART_STORAGE_KEY)
}

export function shouldHandleUiUpdateReloadRequest(
  reloadRequestedAt: number | null | undefined,
  lastHandledReloadRequest: string | null
) {
  if (!reloadRequestedAt) return false
  return String(reloadRequestedAt) !== lastHandledReloadRequest
}

function getLastHandledUiUpdateReloadRequest() {
  return window.sessionStorage.getItem(UI_UPDATE_RELOAD_REQUEST_STORAGE_KEY)
}

function setLastHandledUiUpdateReloadRequest(reloadRequestedAt: number) {
  window.sessionStorage.setItem(UI_UPDATE_RELOAD_REQUEST_STORAGE_KEY, String(reloadRequestedAt))
}

export function getUiUpdateReadinessPath() {
  return "/auth/status"
}

async function isServerReady(fetchImpl: typeof fetch = fetch) {
  const response = await fetchImpl(getUiUpdateReadinessPath(), {
    method: "GET",
    cache: "no-store",
    headers: {
      Accept: "application/json",
    },
  })

  return response.ok
}

export interface ProjectRequest {
  mode: "new" | "existing"
  localPath: string
  title: string
}

export type StartChatIntent =
  | { kind: "project_id"; projectId: string }
  | { kind: "local_path"; localPath: string }
  | { kind: "project_request"; project: ProjectRequest }

export interface SessionForkOperation {
  kind: "fork" | "convert_preview" | "convert"
  sourceTitle: string
  targetProvider?: AgentProvider
}

export function resolveComposeIntent(params: {
  selectedProjectId: string | null
  sidebarProjectId?: string | null
  fallbackLocalProjectPath?: string | null
}): StartChatIntent | null {
  const projectId = params.selectedProjectId ?? params.sidebarProjectId ?? null
  if (projectId) {
    return { kind: "project_id", projectId }
  }

  if (params.fallbackLocalProjectPath) {
    return { kind: "local_path", localPath: params.fallbackLocalProjectPath }
  }

  return null
}

function getSidebarProjectLocalPath(projectGroups: SidebarData["projectGroups"], projectId: string | null | undefined) {
  if (!projectId) return null
  return projectGroups.find((group) => group.groupKey === projectId)?.localPath || null
}

export function resolveProjectStartIntent(projectGroups: SidebarData["projectGroups"], projectId: string): StartChatIntent {
  const localPath = getSidebarProjectLocalPath(projectGroups, projectId)
  return localPath ? { kind: "local_path", localPath } : { kind: "project_id", projectId }
}

export function getActiveChatSnapshot(chatSnapshot: ChatSnapshot | null, activeChatId: string | null): ChatSnapshot | null {
  if (!chatSnapshot) return null
  if (!activeChatId) return null
  if (chatSnapshot.runtime.chatId !== activeChatId) {
    logAbolqasemState("stale snapshot masked", {
      routeChatId: activeChatId,
      snapshotChatId: chatSnapshot.runtime.chatId,
      snapshotProvider: chatSnapshot.runtime.provider,
    })
    return null
  }
  return chatSnapshot
}

export interface AbolqasemState {
  socket: AbolqasemSocket
  activeChatId: string | null
  activeProjectId: string | null
  sidebarData: SidebarData
  localProjects: LocalProjectsSnapshot | null
  updateSnapshot: UpdateSnapshot | null
  chatSnapshot: ChatSnapshot | null
  chatDiffSnapshot: ChatDiffSnapshot | null
  keybindings: KeybindingsSnapshot | null
  appSettings: AppSettingsSnapshot | null
  llmProvider: LlmProviderSnapshot | null
  connectionStatus: SocketStatus
  sidebarReady: boolean
  chatReady: boolean
  localProjectsReady: boolean
  commandError: string | null
  sessionForkOperation: SessionForkOperation | null
  creatingChatProjectId: string | null
  pendingArchiveChatIds: ReadonlySet<string>
  startingLocalPath: string | null
  sidebarOpen: boolean
  sidebarCollapsed: boolean
  messages: ReturnType<typeof processTranscriptMessages>
  queuedMessages: QueuedChatMessage[]
  previousPrompt: string | null
  latestToolIds: ReturnType<typeof getLatestToolIds>
  runtime: ChatSnapshot["runtime"] | null
  runtimeStatus: string | null
  isHistoryLoading: boolean
  hasOlderHistory: boolean
  availableProviders: ProviderCatalogEntry[]
  isProcessing: boolean
  canCancel: boolean
  isDraining: boolean
  navbarLocalPath?: string
  editorLabel: string
  hasSelectedProject: boolean
  addProjectModalOpen: boolean
  openSidebar: () => void
  closeSidebar: () => void
  collapseSidebar: () => void
  expandSidebar: () => void
  openAddProjectModal: () => void
  closeAddProjectModal: () => void
  loadOlderHistory: () => Promise<void>
  loadHistoryAround: (targetCursor: string, limit?: number) => Promise<boolean>
  refreshChatTranscript: () => Promise<ChatSnapshot | null>
  handleCreateChat: (projectId: string) => Promise<void>
  handleForkChat: (chat: SidebarChatRow) => Promise<void>
  handleConvertChat: (chat: SidebarChatRow, provider: AgentProvider) => Promise<void>
  handleOpenLocalProject: (localPath: string) => Promise<void>
  handleCreateProject: (project: ProjectRequest) => Promise<void>
  handleCheckForUpdates: (options?: { force?: boolean }) => Promise<void>
  handleInstallUpdate: () => Promise<void>
  handleReadAppSettings: () => Promise<void>
  handleWriteAppSettings: (patch: AppSettingsPatch) => Promise<void>
  handleReadLlmProvider: () => Promise<void>
  handleWriteLlmProvider: (value: Pick<LlmProviderSnapshot, "provider" | "apiKey" | "model" | "baseUrl">) => Promise<void>
  handleValidateLlmProvider: (value: Pick<LlmProviderSnapshot, "provider" | "apiKey" | "model" | "baseUrl">) => Promise<LlmProviderValidationResult>
  handleSignOut: () => Promise<void>
  handleSend: (content: string, options?: { provider?: AgentProvider; model?: string; modelOptions?: ModelOptions; planMode?: boolean; attachments?: ChatAttachment[] }) => Promise<void>
  handleSteerQueuedMessage: (queuedMessageId: string) => Promise<void>
  handleInterruptQueuedMessage: (queuedMessageId: string) => Promise<void>
  handleEditQueuedMessage: (queuedMessageId: string, content: string) => Promise<void>
  handleRemoveQueuedMessage: (queuedMessageId: string) => Promise<void>
  handleCancel: () => Promise<void>
  handleStopDraining: () => Promise<void>
  handleRenameChat: (chat: SidebarChatRow) => Promise<void>
  handleRenameProject: (projectId: string, sidebarTitle: string | undefined, realTitle: string) => Promise<void>
  handleArchiveChat: (chat: SidebarChatRow) => Promise<void>
  handlePinChat: (chat: SidebarChatRow) => Promise<void>
  handleReorderPinnedChats: (chatIds: string[]) => Promise<void>
  handleOpenArchivedChat: (chatId: string) => Promise<void>
  handleDeleteChat: (chat: SidebarChatRow) => Promise<void>
  handleHideProject: (projectId: string) => Promise<void>
  handleReorderProjectGroups: (projectIds: string[]) => Promise<void>
  handleCopyPath: (localPath: string) => Promise<void>
  handleOpenExternal: (action: OpenExternalAction, editor?: EditorOpenSettings) => Promise<void>
  handleOpenExternalPath: (action: "open_finder" | "open_editor", localPath: string) => Promise<void>
  handleOpenLocalLink: (target: OpenLocalLinkTarget, action?: OpenExternalAction, editor?: EditorOpenSettings) => Promise<void>
  handleCompose: () => void
  handleAskUserQuestion: (
    toolUseId: string,
    questions: AskUserQuestionItem[],
    answers: AskUserQuestionAnswerMap
  ) => Promise<void>
  handleApprovalRequest: (toolUseId: string, decision: ApprovalDecision) => Promise<void>
  handleExitPlanMode: (
    toolUseId: string,
    confirmed: boolean,
    clearContext?: boolean,
    message?: string
  ) => Promise<void>
  handleRestoreCheckpoint: (
    checkpointId: string,
    mode: CheckpointRestoreMode,
    promptContent: string
  ) => Promise<CheckpointRestoreResult | null>
}

export function useAbolqasemState(activeChatId: string | null): AbolqasemState {
  const navigate = useNavigate()
  const socket = useAbolqasemSocket()
  const dialog = useAppDialog()
  const { locale, direction } = useI18n()

  const [sidebarData, setSidebarData] = useState<SidebarData>({ projectGroups: [] })
  const [optimisticSidebarProjectOrder, setOptimisticSidebarProjectOrder] = useState<string[] | null>(null)
  const [localProjects, setLocalProjects] = useState<LocalProjectsSnapshot | null>(null)
  const [updateSnapshot, setUpdateSnapshot] = useState<UpdateSnapshot | null>(null)
  const [chatSnapshot, setChatSnapshot] = useState<ChatSnapshot | null>(null)
  const [dismissedQueuedMessageIDs, setDismissedQueuedMessageIDs] = useState<ReadonlySet<string>>(() => new Set())
  const [olderHistoryEntries, setOlderHistoryEntries] = useState<TranscriptEntry[]>([])
  const [isHistoryLoading, setIsHistoryLoading] = useState(false)
  const [historyCursor, setHistoryCursor] = useState<string | null>(null)
  const [hasOlderHistory, setHasOlderHistory] = useState(false)
  const [projectDiffSnapshots, setProjectDiffSnapshots] = useState<Record<string, ChatDiffSnapshot | null>>({})
  const [keybindings, setKeybindings] = useState<KeybindingsSnapshot | null>(null)
  const [appSettings, setAppSettings] = useState<AppSettingsSnapshot | null>(null)
  const [llmProvider, setLlmProvider] = useState<LlmProviderSnapshot | null>(null)
  const [connectionStatus, setConnectionStatus] = useState<SocketStatus>("connecting")
  const [sidebarReady, setSidebarReady] = useState(false)
  const [localProjectsReady, setLocalProjectsReady] = useState(false)
  const [chatReady, setChatReady] = useState(false)
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [addProjectModalOpen, setAddProjectModalOpen] = useState(false)
  const [commandError, setCommandError] = useState<string | null>(null)
  const [sessionForkOperation, setSessionForkOperation] = useState<SessionForkOperation | null>(null)
  const [creatingChatProjectId, setCreatingChatProjectId] = useState<string | null>(null)
  const [pendingArchiveChatIds, setPendingArchiveChatIds] = useState<Set<string>>(() => new Set())
  const [startingLocalPath, setStartingLocalPath] = useState<string | null>(null)
  const [pendingChatId, setPendingChatId] = useState<string | null>(null)
  const [optimisticUserPrompts, setOptimisticUserPrompts] = useState<OptimisticUserPrompt[]>([])
  const [optimisticQueuedMessages, setOptimisticQueuedMessages] = useState<OptimisticQueuedMessage[]>([])
  const [optimisticProcessing, setOptimisticProcessing] = useState<OptimisticProcessingState | null>(null)
  const [focusEpoch, setFocusEpoch] = useState(0)
  const creatingChatProjectIdRef = useRef<string | null>(null)
  const sendToStartingProfilesRef = useRef<Map<string, SendToStartingTrace>>(new Map())
  const pendingArchiveChatIdsRef = useRef<Set<string>>(new Set())
  const draftChatIds = useChatInputStore(useShallow((state) => Object.keys(state.drafts).sort()))
  const attachmentDraftChatIds = useChatInputStore(
    useShallow((state) => Object.keys(state.attachmentDrafts).sort())
  )
  const chatSubscriptionDebugRef = useRef(0)
  const lastStartingRenderedTraceIdRef = useRef<string | null>(null)
  const lastActiveProjectDiffRef = useRef<{ projectId: string | null; diffs: ChatDiffSnapshot | null }>({
    projectId: null,
    diffs: null,
  })
  const editorLabel = getEditorPresetLabel(useTerminalPreferencesStore((store) => store.editorPreset))
  const sidebarProjectGroups = useMemo(
    () => applySidebarProjectOrder(sidebarData.projectGroups, optimisticSidebarProjectOrder),
    [optimisticSidebarProjectOrder, sidebarData.projectGroups]
  )
  const resolvedSidebarData = useMemo(
    () => (
      sidebarProjectGroups === sidebarData.projectGroups
        ? sidebarData
        : {
            ...sidebarData,
            projectGroups: sidebarProjectGroups,
          }
    ),
    [sidebarData, sidebarProjectGroups]
  )

  useEffect(() => socket.onStatus(setConnectionStatus), [socket])

  useEffect(() => {
    if (connectionStatus !== "connected") return
    setCommandError((current) => isTransportConnectionError(current) ? null : current)
  }, [connectionStatus])

  // Transport recovery is represented by the connection indicator and the
  // command's loading state. Never leave a transient timeout banner attached
  // to the transcript after the socket has begun reconnecting.
  useEffect(() => {
    if (!isTransportConnectionError(commandError)) return
    setCommandError(null)
  }, [commandError])

  useEffect(() => {
    return socket.subscribe<SidebarData>({ type: "sidebar" }, (snapshot) => {
      setSidebarData(snapshot)
      setOptimisticSidebarProjectOrder((current) => (
        current && applySidebarProjectOrder(snapshot.projectGroups, current) === snapshot.projectGroups
          ? null
          : current
      ))
      setSidebarReady(true)
      setCommandError(null)
    })
  }, [socket])

  useEffect(() => {
    if (connectionStatus !== "connected") return

    const protectedChatIds = [...new Set([...draftChatIds, ...attachmentDraftChatIds])].sort()
    void socket.command({ type: "chat.setDraftProtection", chatIds: protectedChatIds }).catch((error) => {
      setCommandError(error instanceof Error ? error.message : String(error))
    })
  }, [attachmentDraftChatIds, connectionStatus, draftChatIds, socket])

  useEffect(() => {
    return socket.subscribe<LocalProjectsSnapshot>({ type: "local-projects" }, (snapshot) => {
      setLocalProjects(snapshot)
      setLocalProjectsReady(true)
      setCommandError(null)
    })
  }, [socket])

  useEffect(() => {
    return socket.subscribe<UpdateSnapshot>({ type: "update" }, (snapshot) => {
      setUpdateSnapshot(snapshot)
      setCommandError(null)
    })
  }, [socket])

  useEffect(() => {
    if (connectionStatus !== "connected") return
    void socket.command<UpdateSnapshot>({ type: "update.check", force: true }).catch((error) => {
      setCommandError(error instanceof Error ? error.message : String(error))
    })
  }, [connectionStatus, socket])

  useEffect(() => {
    const reloadRequestedAt = updateSnapshot?.reloadRequestedAt
    if (!shouldHandleUiUpdateReloadRequest(reloadRequestedAt, getLastHandledUiUpdateReloadRequest())) {
      return
    }
    if (!reloadRequestedAt) {
      return
    }

    setLastHandledUiUpdateReloadRequest(reloadRequestedAt)
    setUiUpdateRestartPhase("awaiting_disconnect")
  }, [updateSnapshot?.reloadRequestedAt])

  useEffect(() => {
    const phase = getUiUpdateRestartPhase()
    const reconnectAction = getUiUpdateRestartReconnectAction(phase, connectionStatus)
    if (reconnectAction === "awaiting_server_ready") {
      setUiUpdateRestartPhase("awaiting_server_ready")
      return
    }
  }, [connectionStatus])

  useEffect(() => {
    if (getUiUpdateRestartPhase() !== "awaiting_server_ready") {
      return
    }

    let cancelled = false
    let timeoutId: number | null = null

    const pollServerReadiness = async () => {
      try {
        if (await isServerReady()) {
          if (cancelled) return
          clearUiUpdateRestartPhase()
          window.location.reload()
          return
        }
      } catch {
        // Keep polling while the process restarts.
      }

      if (cancelled) return
      timeoutId = window.setTimeout(() => {
        void pollServerReadiness()
      }, 500)
    }

    void pollServerReadiness()

    return () => {
      cancelled = true
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId)
      }
    }
  }, [connectionStatus])

  useEffect(() => {
    function handleWindowFocus() {
      if (!updateSnapshot?.lastCheckedAt) return
      if (Date.now() - updateSnapshot.lastCheckedAt <= 60 * 60 * 1000) return
      void socket.command<UpdateSnapshot>({ type: "update.check" }).catch((error) => {
        setCommandError(error instanceof Error ? error.message : String(error))
      })
    }

    window.addEventListener("focus", handleWindowFocus)
    return () => {
      window.removeEventListener("focus", handleWindowFocus)
    }
  }, [socket, updateSnapshot?.lastCheckedAt])

  useEffect(() => {
    return socket.subscribe<KeybindingsSnapshot>({ type: "keybindings" }, (snapshot) => {
      setKeybindings(snapshot)
      setCommandError(null)
    })
  }, [socket])

  useEffect(() => {
    return socket.subscribe<AppSettingsSnapshot>({ type: "app-settings" }, (snapshot) => {
      setAppSettings(snapshot)
      syncRuntimeStoresFromAppSettings(snapshot)
      setCommandError(null)
    })
  }, [socket])

  const handleReadAppSettings = useCallback(async () => {
    try {
      useAppSettingsStore.getState().setHydrationStatus("loading")
      const snapshot = await socket.command<AppSettingsSnapshot>({ type: "settings.readAppSettings" })
      setAppSettings(snapshot)
      syncRuntimeStoresFromAppSettings(snapshot)
      setCommandError(null)
    } catch (error) {
      useAppSettingsStore.getState().setHydrationStatus("error")
      setCommandError(error instanceof Error ? error.message : String(error))
    }
  }, [socket])

  const handleWriteAppSettings = useCallback(async (patch: AppSettingsPatch) => {
    try {
      useAppSettingsStore.getState().applyOptimisticPatch(patch)
      const snapshot = await socket.command<AppSettingsSnapshot>({
        type: "settings.writeAppSettingsPatch",
        patch,
      })
      setAppSettings(snapshot)
      syncRuntimeStoresFromAppSettings(snapshot)
      setCommandError(null)
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
      await handleReadAppSettings()
      throw error
    }
  }, [handleReadAppSettings, socket])

  const handleReadLlmProvider = useCallback(async () => {
    try {
      const snapshot = await socket.command<LlmProviderSnapshot>({ type: "settings.readLlmProvider" })
      setLlmProvider(snapshot)
      setCommandError(null)
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
    }
  }, [socket])

  const handleWriteLlmProvider = useCallback(async (
    value: Pick<LlmProviderSnapshot, "provider" | "apiKey" | "model" | "baseUrl">
  ) => {
    try {
      const snapshot = await socket.command<LlmProviderSnapshot>({
        type: "settings.writeLlmProvider",
        provider: value.provider,
        apiKey: value.apiKey,
        model: value.model,
        baseUrl: value.baseUrl,
      })
      setLlmProvider(snapshot)
      setCommandError(null)
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
      throw error
    }
  }, [socket])

  const handleValidateLlmProvider = useCallback(async (
    value: Pick<LlmProviderSnapshot, "provider" | "apiKey" | "model" | "baseUrl">
  ) => {
    return await socket.command<LlmProviderValidationResult>({
      type: "settings.validateLlmProvider",
      provider: value.provider,
      apiKey: value.apiKey,
      model: value.model,
      baseUrl: value.baseUrl,
    })
  }, [socket])

  useEffect(() => {
    if (connectionStatus !== "connected") return
    void handleReadAppSettings()
  }, [connectionStatus, handleReadAppSettings])

  useEffect(() => {
    if (connectionStatus !== "connected") return
    if (appSettings?.browserSettingsMigrated !== false) return
    const patch = readLegacyBrowserSettingsPatch()
    if (!patch) return
    void handleWriteAppSettings(patch)
      .then(clearLegacyBrowserSettings)
      .catch(() => undefined)
  }, [appSettings?.browserSettingsMigrated, connectionStatus, handleWriteAppSettings])

  useEffect(() => {
    if (connectionStatus !== "connected") return
    void handleReadLlmProvider()
  }, [connectionStatus, handleReadLlmProvider])

  useEffect(() => {
    function handleFocusSignal() {
      setFocusEpoch((value) => value + 1)
    }

    window.addEventListener("focus", handleFocusSignal)
    document.addEventListener("visibilitychange", handleFocusSignal)

    return () => {
      window.removeEventListener("focus", handleFocusSignal)
      document.removeEventListener("visibilitychange", handleFocusSignal)
    }
  }, [])

  useEffect(() => {
    if (!activeChatId) {
      logAbolqasemState("clearing chat snapshot for non-chat route")
      setChatSnapshot(null)
      setChatReady(true)
      return
    }

    const subscriptionId = ++chatSubscriptionDebugRef.current
    logAbolqasemState("subscribing to chat", {
      subscriptionId,
      activeChatId,
      sidebarProjectGroups: sidebarProjectGroups.length,
      sidebarChatCount: sidebarProjectGroups.reduce((count, group) => count + group.chats.length, 0),
    })
    setChatSnapshot(null)
    setChatReady(false)
    const unsubscribe = socket.subscribe<ChatSnapshot | null>({ type: "chat", chatId: activeChatId, recentLimit: INITIAL_CHAT_RECENT_LIMIT }, (snapshot) => {
      const normalizedSnapshot = normalizeChatSnapshot(snapshot)
      if (normalizedSnapshot?.runtime.chatId) {
        const matchingTrace = [...sendToStartingProfilesRef.current.values()]
          .filter((trace) => trace.serverChatId === normalizedSnapshot.runtime.chatId)
          .sort((left, right) => right.startedAt - left.startedAt)[0]
        if (matchingTrace && matchingTrace.snapshotAt === undefined) {
          matchingTrace.snapshotAt = performance.now()
          logSendToStartingTrace(matchingTrace, "chat_snapshot_received", {
            status: normalizedSnapshot.runtime.status,
            messageCount: normalizedSnapshot.messages.length,
          })
        }
      }
      setChatSnapshot((current) => {
        const reused = sameChatSnapshotCore(current, normalizedSnapshot)
        logAbolqasemState("chat snapshot received", {
          subscriptionId,
          activeChatId,
          snapshotChatId: normalizedSnapshot?.runtime.chatId ?? null,
          snapshotProvider: normalizedSnapshot?.runtime.provider ?? null,
          snapshotStatus: normalizedSnapshot?.runtime.status ?? null,
          messageCount: normalizedSnapshot?.messages.length ?? 0,
          diffStatus: null,
          diffFileCount: 0,
          reusedSnapshot: reused,
        })
        return reused ? current : normalizedSnapshot
      })
      setHistoryCursor(normalizedSnapshot?.history.olderCursor ?? null)
      setHasOlderHistory(normalizedSnapshot?.history.hasOlder ?? false)
      setChatReady(true)
      setCommandError(null)
    })
    return () => {
      logAbolqasemState("unsubscribing from chat", {
        subscriptionId,
        activeChatId,
        sidebarProjectGroups: sidebarProjectGroups.length,
        sidebarChatCount: sidebarProjectGroups.reduce((count, group) => count + group.chats.length, 0),
      })
      unsubscribe()
    }
  }, [activeChatId, socket])

  useEffect(() => {
    if (!activeChatId || connectionStatus !== "connected") return

    let cancelled = false
    let inFlight = false
    let timerId: number | null = null

    const clearTimer = () => {
      if (timerId === null) return
      window.clearTimeout(timerId)
      timerId = null
    }
    const schedule = (delay: number) => {
      clearTimer()
      timerId = window.setTimeout(refresh, delay)
    }
    const refresh = () => {
      if (cancelled) return
      if (inFlight) {
        schedule(getActiveChatRefreshDelay())
        return
      }
      inFlight = true
      void socket.command({ type: "chat.refresh", chatId: activeChatId })
        // This is an opportunistic sync. Connection recovery already owns the
        // user-facing error state, so a transient background miss stays quiet.
        .catch(() => undefined)
        .finally(() => {
          inFlight = false
          if (!cancelled) schedule(getActiveChatRefreshDelay())
        })
    }
    const refreshImmediately = () => {
      if (document.visibilityState !== "visible") return
      clearTimer()
      refresh()
    }

    document.addEventListener("visibilitychange", refreshImmediately)
    window.addEventListener("focus", refreshImmediately)
    refresh()
    return () => {
      cancelled = true
      clearTimer()
      document.removeEventListener("visibilitychange", refreshImmediately)
      window.removeEventListener("focus", refreshImmediately)
    }
  }, [activeChatId, connectionStatus, socket])

  useEffect(() => {
    if (selectedProjectId) return
    const firstGroup = sidebarProjectGroups[0]
    if (firstGroup) {
      setSelectedProjectId(firstGroup.groupKey)
    }
  }, [selectedProjectId, sidebarProjectGroups])

  useEffect(() => {
    if (!activeChatId) return
    if (!sidebarReady || !chatReady) return
    const exists = sidebarProjectGroups.some((group) => group.chats.some((chat) => chat.chatId === activeChatId))
    if (exists) {
      if (pendingChatId === activeChatId) {
        setPendingChatId(null)
      }
      return
    }
    if (pendingChatId === activeChatId) {
      return
    }
    navigate("/")
  }, [activeChatId, chatReady, navigate, pendingChatId, sidebarProjectGroups, sidebarReady])

  useEffect(() => {
    if (!chatSnapshot) return
    setSelectedProjectId(chatSnapshot.runtime.projectId)
    if (pendingChatId === chatSnapshot.runtime.chatId) {
      setPendingChatId(null)
    }
  }, [chatSnapshot, pendingChatId])

  useEffect(() => {
    if (!activeChatId || !sidebarReady) return
    if (!shouldMarkActiveChatRead()) return
    const activeSidebarChat = sidebarProjectGroups
      .flatMap((group) => group.chats)
      .find((chat) => chat.chatId === activeChatId)
    if (!activeSidebarChat?.unread) return
    void socket.command({ type: "chat.markRead", chatId: activeChatId }).catch((error) => {
      setCommandError(error instanceof Error ? error.message : String(error))
    })
  }, [activeChatId, focusEpoch, sidebarProjectGroups, sidebarReady, socket])

  useEffect(() => {
    setOlderHistoryEntries([])
    setIsHistoryLoading(false)
    setHistoryCursor(null)
    setHasOlderHistory(false)
  }, [activeChatId])

  const activeChatSnapshot = useMemo(
    () => getActiveChatSnapshot(chatSnapshot, activeChatId),
    [activeChatId, chatSnapshot]
  )
  const activeProjectId = useMemo(
    () => activeChatSnapshot?.runtime.projectId
      ?? getProjectIdForChat(sidebarProjectGroups, activeChatId)
      ?? selectedProjectId,
    [activeChatId, activeChatSnapshot?.runtime.projectId, selectedProjectId, sidebarProjectGroups]
  )
  const chatDiffSnapshot = useMemo(() => {
    const currentDiffs = activeProjectId ? (projectDiffSnapshots[activeProjectId] ?? null) : null
    if (activeProjectId && currentDiffs) {
      lastActiveProjectDiffRef.current = {
        projectId: activeProjectId,
        diffs: currentDiffs,
      }
      return currentDiffs
    }

    if (activeProjectId && lastActiveProjectDiffRef.current.projectId === activeProjectId) {
      return lastActiveProjectDiffRef.current.diffs
    }

    return currentDiffs
  }, [activeProjectId, projectDiffSnapshots])

  useEffect(() => {
    if (!activeProjectId) {
      return
    }

    const unsubscribe = socket.subscribe<ChatDiffSnapshot | null>({ type: "project-git", projectId: activeProjectId }, (snapshot) => {
      setProjectDiffSnapshots((current) => {
        const nextDiffs = snapshot ?? null
        if (shouldPreserveExistingProjectDiffs(current[activeProjectId] ?? null, nextDiffs)) {
          return current
        }
        if (sameDiffs(current[activeProjectId] ?? null, nextDiffs)) {
          return current
        }
        return {
          ...current,
          [activeProjectId]: nextDiffs,
        }
      })
      setCommandError(null)
    })

    return unsubscribe
  }, [activeProjectId, socket])
  useEffect(() => {
    logAbolqasemState("active snapshot resolved", {
      routeChatId: activeChatId,
      rawSnapshotChatId: chatSnapshot?.runtime.chatId ?? null,
      rawSnapshotProvider: chatSnapshot?.runtime.provider ?? null,
      activeSnapshotChatId: activeChatSnapshot?.runtime.chatId ?? null,
      activeSnapshotProvider: activeChatSnapshot?.runtime.provider ?? null,
      pendingChatId,
    })
  }, [activeChatId, activeChatSnapshot, chatSnapshot, pendingChatId])
  const serverTranscriptEntries = useMemo(
    () => mergeTranscriptEntries(olderHistoryEntries, activeChatSnapshot?.messages ?? []),
    [activeChatSnapshot?.messages, olderHistoryEntries]
  )
  const optimisticScopeId = activeChatId ?? NEW_CHAT_OPTIMISTIC_SCOPE
  const runtime = activeChatSnapshot?.runtime ?? null
  const serverQueuedMessages = activeChatSnapshot?.queuedMessages ?? []
  const queuedMessages = useMemo(
    () => mergeOptimisticQueuedMessages(serverQueuedMessages, optimisticQueuedMessages, optimisticScopeId),
    [optimisticQueuedMessages, optimisticScopeId, serverQueuedMessages],
  )
  const visibleQueuedMessages = useMemo(
    () => queuedMessages.filter((message) => !dismissedQueuedMessageIDs.has(message.id)),
    [dismissedQueuedMessageIDs, queuedMessages],
  )
  const queueDeliveryMode = appSettings?.queueDeliveryMode ?? "queue"

  useEffect(() => {
    if (serverQueuedMessages.length === 0) return
    setOptimisticQueuedMessages((current) => reconcileOptimisticQueuedMessages(current, serverQueuedMessages, optimisticScopeId))
  }, [optimisticScopeId, serverQueuedMessages])

  useEffect(() => {
    if (dismissedQueuedMessageIDs.size === 0) return
    const serverIDs = new Set(serverQueuedMessages.map((message) => message.id))
    setDismissedQueuedMessageIDs((current) => {
      const next = new Set([...current].filter((id) => serverIDs.has(id)))
      return next.size === current.size ? current : next
    })
  }, [dismissedQueuedMessageIDs, serverQueuedMessages])

	const shouldShowOptimisticWebPrompts = true
  const optimisticTranscriptEntries = useMemo(
    () => {
      if (!shouldShowOptimisticWebPrompts) {
        return []
      }
      // Reconcile synchronously during render as well as in the effect below.
      // This prevents one extra frame (and, for slow sockets, a persistent
      // duplicate) when the native transcript already contains the prompt.
      const visiblePrompts = reconcileOptimisticUserPrompts(
        optimisticUserPrompts,
        optimisticScopeId,
        serverTranscriptEntries,
      )
      return visiblePrompts
        .filter((prompt) => prompt.scopeId === optimisticScopeId)
        .map((prompt) => prompt.entry)
    },
    [optimisticScopeId, optimisticUserPrompts, serverTranscriptEntries, shouldShowOptimisticWebPrompts]
  )
  const transcriptEntries = useMemo(
    () => [...serverTranscriptEntries, ...optimisticTranscriptEntries],
    [optimisticTranscriptEntries, serverTranscriptEntries]
  )
  const messages = useMemo(() => processTranscriptMessages(transcriptEntries), [transcriptEntries])
  const previousPrompt = useMemo(() => getPreviousPrompt(messages), [messages])
  const latestToolIds = useMemo(() => getLatestToolIds(messages), [messages])
  const optimisticRuntimeStatus = shouldShowOptimisticWebPrompts && optimisticProcessing?.scopeId === optimisticScopeId && (!runtime || runtime.status === "idle")
    ? "starting"
    : null
  const effectiveRuntimeStatus = optimisticRuntimeStatus ?? runtime?.status ?? null
  const availableProviders = activeChatSnapshot?.availableProviders ?? PROVIDERS
  const isProcessing = isProcessingStatus(effectiveRuntimeStatus ?? undefined)
  const canCancel = canCancelStatus(effectiveRuntimeStatus ?? undefined)
  const isDraining = runtime?.isDraining ?? false
  const fallbackLocalProjectPath = localProjects?.projects[0]?.localPath ?? null
  const navbarLocalPath =
    runtime?.localPath
    ?? fallbackLocalProjectPath
    ?? sidebarProjectGroups[0]?.localPath
  const hasSelectedProject = Boolean(
    selectedProjectId
    ?? runtime?.projectId
    ?? sidebarProjectGroups[0]?.groupKey
    ?? fallbackLocalProjectPath
  )

  useEffect(() => {
    if (optimisticProcessing?.scopeId !== optimisticScopeId) {
      return
    }
    if (runtime?.status && runtime.status !== "idle") {
      setOptimisticProcessing(null)
    }
  }, [optimisticProcessing, optimisticScopeId, runtime?.status])

  useEffect(() => {
    if (!optimisticProcessing?.ackedAt || optimisticProcessing.scopeId !== optimisticScopeId) {
      return
    }
    if (runtime?.status && runtime.status !== "idle") {
      return
    }
    const timeoutId = window.setTimeout(() => {
      setOptimisticProcessing((current) => (
        current?.scopeId === optimisticScopeId && current.ackedAt === optimisticProcessing.ackedAt
          ? null
          : current
      ))
    }, 300)
    return () => window.clearTimeout(timeoutId)
  }, [optimisticProcessing, optimisticScopeId, runtime?.status])

  useEffect(() => {
    if (!activeChatId || runtime?.status !== "starting") {
      return
    }

    const matchingTrace = [...sendToStartingProfilesRef.current.values()]
      .filter((trace) => trace.serverChatId === activeChatId)
      .sort((left, right) => right.startedAt - left.startedAt)[0]
    if (!matchingTrace || matchingTrace.startingStatusAt !== undefined) {
      return
    }

    matchingTrace.startingStatusAt = performance.now()
    logSendToStartingTrace(matchingTrace, "runtime_status_starting", {
      status: runtime.status,
    })
  }, [activeChatId, runtime?.status])

  useEffect(() => {
    if (!activeChatId || !runtime || runtime.status === "starting") {
      return
    }

    const matchingTrace = [...sendToStartingProfilesRef.current.values()]
      .filter((trace) => trace.serverChatId === activeChatId)
      .sort((left, right) => right.startedAt - left.startedAt)[0]
    if (!matchingTrace || matchingTrace.startingRenderedAt !== undefined) {
      return
    }

    logSendToStartingTrace(matchingTrace, "starting_not_observed", {
      status: runtime.status,
    })
    sendToStartingProfilesRef.current.delete(matchingTrace.traceId)
  }, [activeChatId, runtime])

  useLayoutEffect(() => {
    if (!activeChatId || runtime?.status !== "starting") {
      lastStartingRenderedTraceIdRef.current = null
      return
    }

    const matchingTrace = [...sendToStartingProfilesRef.current.values()]
      .filter((trace) => trace.serverChatId === activeChatId)
      .sort((left, right) => right.startedAt - left.startedAt)[0]
    if (!matchingTrace) {
      return
    }

    if (lastStartingRenderedTraceIdRef.current === matchingTrace.traceId) {
      return
    }

    lastStartingRenderedTraceIdRef.current = matchingTrace.traceId
    matchingTrace.startingRenderedAt = performance.now()
    logSendToStartingTrace(matchingTrace, "starting_render_committed", {
      totalMs: elapsedTraceMs(matchingTrace.startedAt),
    })
    sendToStartingProfilesRef.current.delete(matchingTrace.traceId)
  }, [activeChatId, runtime?.status])

  useEffect(() => {
    setOptimisticUserPrompts((current) => {
      const reconciled = reconcileOptimisticUserPrompts(current, optimisticScopeId, serverTranscriptEntries)
      if (reconciled.length === current.length && reconciled.every((prompt, index) => prompt === current[index])) {
        return current
      }
      return reconciled
    })
  }, [optimisticScopeId, serverTranscriptEntries])

  const loadOlderHistory = useCallback(async () => {
    if (!activeChatId || !historyCursor || isHistoryLoading || !hasOlderHistory) {
      return
    }

    setIsHistoryLoading(true)
    try {
      const page = await socket.command<ChatHistoryPage>({
        type: "chat.loadHistory",
        chatId: activeChatId,
        beforeCursor: historyCursor,
        limit: CHAT_HISTORY_PAGE_SIZE,
      })
      setOlderHistoryEntries((current) => mergeTranscriptEntries(page.messages, current))
      setHistoryCursor(page.olderCursor)
      setHasOlderHistory(page.hasOlder)
      setCommandError(null)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setCommandError(message)
    } finally {
      setIsHistoryLoading(false)
    }
  }, [activeChatId, hasOlderHistory, historyCursor, isHistoryLoading, socket])

  const loadHistoryAround = useCallback(async (targetCursor: string, limit = CHAT_HISTORY_PAGE_SIZE * 2) => {
    const normalizedTargetCursor = targetCursor.trim()
    if (!activeChatId || !normalizedTargetCursor || isHistoryLoading) {
      return false
    }

    setIsHistoryLoading(true)
    try {
      const page = await socket.command<ChatHistoryPage>({
        type: "chat.loadHistoryAround",
        chatId: activeChatId,
        targetCursor: normalizedTargetCursor,
        limit,
      })
      if (!page.targetFound) {
        return false
      }
      setOlderHistoryEntries((current) => mergeTranscriptEntries(page.messages, current))
      setHistoryCursor(page.olderCursor)
      setHasOlderHistory(page.hasOlder)
      setCommandError(null)
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setCommandError(message)
      return false
    } finally {
      setIsHistoryLoading(false)
    }
  }, [activeChatId, isHistoryLoading, socket])

	const createChatForProject = useCallback(async (projectId: string) => {
    if (creatingChatProjectIdRef.current) {
      return
    }
    creatingChatProjectIdRef.current = projectId
    setCreatingChatProjectId(projectId)
    const chatPreferences = useChatPreferencesStore.getState()
    try {
      setCommandError(null)
      const baseSourceComposerState = activeChatId
        ? chatPreferences.getComposerState(activeChatId)
        : chatPreferences.getComposerState(NEW_CHAT_COMPOSER_ID)
		const composerState = getComposerStateForActiveProvider(
			baseSourceComposerState,
			activeChatId ? runtime?.provider ?? null : null,
			chatPreferences.providerDefaults
		)
		const result = await socket.command<{ chatId: string }>({
			type: "chat.create",
			projectId,
			provider: composerState.provider,
		})
		chatPreferences.initializeComposerForChat(result.chatId, { sourceState: composerState })
      setSelectedProjectId(projectId)
      setPendingChatId(result.chatId)
      navigate(chatRoute(result.chatId))
      setSidebarOpen(false)
      setCommandError(null)
    } finally {
      creatingChatProjectIdRef.current = null
      setCreatingChatProjectId(null)
    }
	}, [activeChatId, navigate, runtime?.provider, socket])

  const resolveProjectIdForStartChat = useCallback(async (intent: StartChatIntent): Promise<{ projectId: string; localPath?: string }> => {
    if (intent.kind === "project_id") {
      return { projectId: intent.projectId }
    }

    if (intent.kind === "local_path") {
      const result = await socket.command<{ projectId: string }>({ type: "project.open", localPath: intent.localPath })
      return { projectId: result.projectId, localPath: intent.localPath }
    }

    const result = await socket.command<{ projectId: string }>(
      intent.project.mode === "new"
        ? { type: "project.create", localPath: intent.project.localPath, title: intent.project.title }
        : { type: "project.open", localPath: intent.project.localPath }
    )
    return { projectId: result.projectId, localPath: intent.project.localPath }
  }, [socket])

  const startChatFromIntent = useCallback(async (intent: StartChatIntent) => {
    try {
      const localPath = intent.kind === "project_id"
        ? null
        : intent.kind === "local_path"
          ? intent.localPath
          : intent.project.localPath
      if (localPath) {
        setStartingLocalPath(localPath)
      }

      const { projectId } = await resolveProjectIdForStartChat(intent)
      await createChatForProject(projectId)
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
    } finally {
      setStartingLocalPath(null)
    }
  }, [createChatForProject, resolveProjectIdForStartChat])

  const startChatForProjectId = useCallback(async (projectId: string) => {
    await startChatFromIntent(resolveProjectStartIntent(sidebarProjectGroups, projectId))
  }, [sidebarProjectGroups, startChatFromIntent])

  const handleCreateChat = useCallback(async (projectId: string) => {
    await startChatForProjectId(projectId)
  }, [startChatForProjectId])

  const handleForkChat = useCallback(async (chat: SidebarChatRow) => {
    if (sessionForkOperation) return
    try {
      setCommandError(null)
      setSessionForkOperation({ kind: "fork", sourceTitle: chat.title })
      const result = await socket.command<{ chatId: string }>({
        type: "chat.fork",
        chatId: chat.chatId,
      })
      const chatPreferences = useChatPreferencesStore.getState()
      const sourceComposerState = getComposerStateForActiveProvider(
        chatPreferences.getComposerState(chat.chatId),
        chat.provider,
        chatPreferences.providerDefaults
      )
      chatPreferences.initializeComposerForChat(result.chatId, {
        sourceState: sourceComposerState,
      })
      setPendingChatId(result.chatId)
      navigate(chatRoute(result.chatId))
      setSidebarOpen(false)
      setCommandError(null)
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
    } finally {
      setSessionForkOperation(null)
    }
  }, [navigate, sessionForkOperation, socket])

  const handleConvertChat = useCallback(async (chat: SidebarChatRow, provider: AgentProvider) => {
    if (sessionForkOperation) return
    try {
      setCommandError(null)
      setSessionForkOperation({ kind: "convert_preview", sourceTitle: chat.title, targetProvider: provider })
      const preview = await socket.command<ChatConversionPreview>({
        type: "chat.convertPreview",
        chatId: chat.chatId,
        targetProvider: provider,
      })
      setSessionForkOperation(null)
		const providerLabel = provider === "claude" ? "Claude" : provider === "opencode" ? "OpenCode" : "Codex"
      const confirmed = await dialog.confirm({
        dir: direction,
        title: locale === "fa" ? `Fork به ${providerLabel}؟` : `Fork to ${providerLabel}?`,
        description: [
          preview.sourceTitle,
          locale === "fa" ? `پیام‌های کاربر: ${preview.userMessages}` : `User messages: ${preview.userMessages}`,
          locale === "fa" ? `پیام‌های دستیار: ${preview.assistantMessages}` : `Assistant messages: ${preview.assistantMessages}`,
          locale === "fa" ? `Tool callها: ${preview.toolCalls}` : `Tool calls: ${preview.toolCalls}`,
          locale === "fa" ? `Tool resultها: ${preview.toolResults}` : `Tool results: ${preview.toolResults}`,
          locale === "fa" ? `مرزهای compact: ${preview.compactBoundaries}` : `Compact boundaries: ${preview.compactBoundaries}`,
          locale === "fa" ? `خلاصه‌های compact: ${preview.compactSummaries}` : `Compact summaries: ${preview.compactSummaries}`,
          locale === "fa" ? `ورودی‌های منتقل‌شونده: ${preview.importedMessageCount}` : `Imported entries: ${preview.importedMessageCount}`,
          preview.skippedEntries > 0 ? (locale === "fa" ? `ورودی‌های ردشده: ${preview.skippedEntries}` : `Skipped entries: ${preview.skippedEntries}`) : null,
          preview.pendingFork ? (locale === "fa" ? "توکن native fork provider هم حفظ می‌شود." : "A native provider fork token will also be preserved.") : null,
        ].filter(Boolean).join("\n"),
        confirmLabel: locale === "fa" ? `Fork به ${providerLabel}` : `Fork to ${providerLabel}`,
        cancelLabel: locale === "fa" ? "لغو" : "Cancel",
      })
      if (!confirmed) return
      setSessionForkOperation({ kind: "convert", sourceTitle: chat.title, targetProvider: provider })
      const result = await socket.command<{ chatId: string }>({
        type: "chat.convert",
        chatId: chat.chatId,
        targetProvider: provider,
      })
      const chatPreferences = useChatPreferencesStore.getState()
      const sourceComposerState = getComposerStateForActiveProvider(
        chatPreferences.getComposerState(chat.chatId),
        chat.provider,
        chatPreferences.providerDefaults
      )
      chatPreferences.initializeComposerForChat(result.chatId, {
        sourceState: sourceComposerState,
      })
      setPendingChatId(result.chatId)
      navigate(chatRoute(result.chatId))
      setSidebarOpen(false)
      setCommandError(null)
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
    } finally {
      setSessionForkOperation(null)
    }
  }, [dialog, direction, locale, navigate, sessionForkOperation, socket])

  const handleOpenLocalProject = useCallback(async (localPath: string) => {
    await startChatFromIntent({ kind: "local_path", localPath })
  }, [startChatFromIntent])

  const handleCreateProject = useCallback(async (project: ProjectRequest) => {
    await startChatFromIntent({ kind: "project_request", project })
  }, [startChatFromIntent])

  const handleCheckForUpdates = useCallback(async (options?: { force?: boolean }) => {
    try {
      await socket.command<UpdateSnapshot>({ type: "update.check", force: options?.force })
      setCommandError(null)
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
    }
  }, [socket])

  const handleInstallUpdate = useCallback(async () => {
    try {
      const result = await socket.command<UpdateInstallResult>({ type: "update.install" })
      if (!result.ok) {
        clearUiUpdateRestartPhase()
        setCommandError(null)
        await dialog.alert({
          title: result.userTitle ?? "Update failed",
          description: result.userMessage ?? "Abolqasem could not install the update. Try again later.",
          closeLabel: "OK",
        })
        return
      }

      if (result.ok && result.action === "reload") {
        window.location.reload()
        return
      }

      if (result.ok && result.action === "restart") {
        setUiUpdateRestartPhase("awaiting_disconnect")
      }
      setCommandError(null)
    } catch (error) {
      clearUiUpdateRestartPhase()
      setCommandError(error instanceof Error ? error.message : String(error))
    }
  }, [dialog, socket])

  const handleSignOut = useCallback(async () => {
    try {
      const response = await fetch("/auth/logout", {
        method: "POST",
        headers: {
          Accept: "application/json",
        },
      })

      if (!response.ok) {
        throw new Error(`Sign out failed with status ${response.status}`)
      }

      setCommandError(null)
      window.location.reload()
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
    }
  }, [])

  const handleSend = useCallback(async (
    content: string,
    options?: { provider?: AgentProvider; model?: string; modelOptions?: ModelOptions; planMode?: boolean; attachments?: ChatAttachment[] }
  ) => {
    const attachments = options?.attachments ?? []
	if (shouldEnqueueUserPrompt(activeChatId, isProcessing)) {
      const queueChatId = activeChatId
      if (!queueChatId) return
      const optimisticQueueID = `optimistic-queue:${generateUUID()}`
      const optimisticMessage: OptimisticQueuedMessage = {
        scopeId: queueChatId,
        retainUntilSettled: queueDeliveryMode === "steer",
        message: {
          id: optimisticQueueID,
          content,
          attachments,
          createdAt: Date.now(),
          provider: options?.provider,
          model: options?.model,
          modelOptions: options?.modelOptions,
          planMode: options?.planMode,
          deliveryState: "submitting",
        },
      }
      setOptimisticQueuedMessages((current) => [...current, optimisticMessage])
      let acknowledgedQueueID = ""
      try {
		const queued = await socket.command<{ queuedMessageId: string }>({
          type: "message.enqueue",
          chatId: queueChatId,
          content,
          attachments,
          provider: options?.provider,
          model: options?.model,
          modelOptions: options?.modelOptions,
          planMode: options?.planMode,
		})
		acknowledgedQueueID = queued.queuedMessageId
		setOptimisticQueuedMessages((current) => current.map((item) => (
			item.message.id === optimisticQueueID
				? { ...item, message: { ...item.message, id: queued.queuedMessageId, deliveryState: queueDeliveryMode === "steer" ? "steering" : undefined } }
				: item
		)))
		if (queueDeliveryMode === "steer" && queued.queuedMessageId) {
			await socket.command({ type: "message.steer", chatId: queueChatId, queuedMessageId: queued.queuedMessageId })
			setDismissedQueuedMessageIDs((current) => new Set(current).add(queued.queuedMessageId))
			setOptimisticQueuedMessages((current) => current.filter((item) => (
				item.message.id !== optimisticQueueID && item.message.id !== queued.queuedMessageId
			)))
		}
        setCommandError(null)
        return
      } catch (error) {
        setOptimisticQueuedMessages((current) => current.filter((item) => item.message.id !== optimisticQueueID && item.message.id !== acknowledgedQueueID))
        const message = error instanceof Error ? error.message : String(error)
        if (acknowledgedQueueID && isQueuedMessageNotFoundError(message)) {
          // A concurrent snapshot or an earlier delivery can win the race with
          // this command. The missing durable row means delivery is already
          // settled, so keep stale snapshots from resurrecting it in the UI.
          setDismissedQueuedMessageIDs((current) => new Set(current).add(acknowledgedQueueID))
          setCommandError(null)
          return
        }
        setCommandError(isTransportConnectionError(message) ? null : message)
        throw error
      }
    }

    const optimisticId = generateUUID()
    const clientTraceId = generateUUID()
    const signature = getUserPromptSignature(content, attachments)
    const contentMatchKey = getUserPromptContentMatchKey(content)
    const optimisticScopeId = activeChatId ?? NEW_CHAT_OPTIMISTIC_SCOPE
	const shouldUseOptimisticWebPrompt = true
    if (shouldUseOptimisticWebPrompt) {
      setOptimisticProcessing({
        scopeId: optimisticScopeId,
        ackedAt: null,
      })
    }
    const sendTrace: SendToStartingTrace = {
      traceId: clientTraceId,
      optimisticId,
      startedAt: performance.now(),
      serverChatId: activeChatId,
      routeChatIdAtSend: activeChatId,
      contentPreview: content.slice(0, 80),
    }
    if (shouldUseOptimisticWebPrompt) {
      sendToStartingProfilesRef.current.set(clientTraceId, sendTrace)
    }
    logSendToStartingTrace(sendTrace, "handle_send_called", {
      optimisticScopeId,
      attachments: attachments.length,
      contentLength: content.length,
      contentPreview: sendTrace.contentPreview,
    })
    if (shouldUseOptimisticWebPrompt) {
      const requiredMatchCount = countMatchingUserPrompts(serverTranscriptEntries, signature)
        + optimisticUserPrompts.filter((prompt) => prompt.scopeId === optimisticScopeId && prompt.signature === signature).length
        + 1
      const requiredContentMatchCount = countMatchingUserPromptContent(serverTranscriptEntries, contentMatchKey)
        + optimisticUserPrompts.filter((prompt) => prompt.scopeId === optimisticScopeId && prompt.contentMatchKey === contentMatchKey).length
        + 1

      setOptimisticUserPrompts((current) => [...current, {
        id: optimisticId,
        scopeId: optimisticScopeId,
        signature,
        requiredMatchCount,
        contentMatchKey,
        requiredContentMatchCount,
        entry: {
          _id: `optimistic:${optimisticId}`,
          kind: "user_prompt",
          content,
          attachments,
          createdAt: Date.now(),
        },
      }])
      logSendToStartingTrace(sendTrace, "optimistic_prompt_added", {
        optimisticId,
        optimisticScopeId,
      })
    }

    try {
      let projectId = activeChatId ? null : selectedProjectId ?? sidebarProjectGroups[0]?.groupKey ?? null
      if (!activeChatId) {
        const localPath = getSidebarProjectLocalPath(sidebarProjectGroups, projectId) ?? (!projectId ? fallbackLocalProjectPath : null)
        if (localPath) {
          const project = await socket.command<{ projectId: string }>({
            type: "project.open",
            localPath,
          })
          projectId = project.projectId
          setSelectedProjectId(projectId)
        }
      }

      if (!activeChatId && !projectId) {
        throw new Error("Open a project first")
      }

      const result = await socket.command<{ chatId?: string }>({
        type: "chat.send",
        chatId: activeChatId ?? undefined,
        projectId: activeChatId ? undefined : projectId ?? undefined,
        clientTraceId,
        provider: options?.provider,
        content,
        attachments,
        model: options?.model,
        modelOptions: options?.modelOptions,
        planMode: options?.planMode,
      })
      sendTrace.ackAt = performance.now()
      sendTrace.serverChatId = result.chatId ?? sendTrace.serverChatId
      if (shouldUseOptimisticWebPrompt) {
        setOptimisticProcessing((current) => {
          if (!current) return current
          const nextScopeId = result.chatId && result.chatId !== current.scopeId ? result.chatId : current.scopeId
          return {
            scopeId: nextScopeId,
            ackedAt: performance.now(),
          }
        })
      }
      logSendToStartingTrace(sendTrace, "chat_send_ack_received", {
        resultChatId: result.chatId ?? null,
      })

      if (shouldUseOptimisticWebPrompt && result.chatId && result.chatId !== optimisticScopeId) {
        setOptimisticUserPrompts((current) => current.map((prompt) => (
          prompt.id === optimisticId ? { ...prompt, scopeId: result.chatId! } : prompt
        )))
      }

      if (result.chatId && result.chatId !== activeChatId) {
        const chatPreferences = useChatPreferencesStore.getState()
        chatPreferences.setComposerState(
          result.chatId,
          composerStateFromSendOptions(options) ?? chatPreferences.getComposerState(activeChatId ?? NEW_CHAT_COMPOSER_ID)
        )
        setPendingChatId(result.chatId)
        navigate(chatRoute(result.chatId))
      }
      setCommandError(null)
    } catch (error) {
      if (shouldUseOptimisticWebPrompt) {
        setOptimisticUserPrompts((current) => current.filter((prompt) => prompt.id !== optimisticId))
        setOptimisticProcessing(null)
      }
      logSendToStartingTrace(sendTrace, "handle_send_failed", {
        error: error instanceof Error ? error.message : String(error),
      })
      sendToStartingProfilesRef.current.delete(clientTraceId)
      const message = error instanceof Error ? error.message : String(error)
      setCommandError(isTransportConnectionError(message) ? null : message)
      throw error
    }
	}, [activeChatId, fallbackLocalProjectPath, isProcessing, navigate, optimisticUserPrompts, queueDeliveryMode, selectedProjectId, serverTranscriptEntries, sidebarProjectGroups, socket])

  const settleQueuedMessage = useCallback((queuedMessageId: string) => {
    setDismissedQueuedMessageIDs((current) => new Set(current).add(queuedMessageId))
    setOptimisticQueuedMessages((current) => current.filter((item) => item.message.id !== queuedMessageId))
  }, [])

  const handleSteerQueuedMessage = useCallback(async (queuedMessageId: string) => {
    if (!activeChatId) return
    try {
      await socket.command({
        type: "message.steer",
        chatId: activeChatId,
        queuedMessageId,
      })
      settleQueuedMessage(queuedMessageId)
      setCommandError(null)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (isQueuedMessageNotFoundError(message)) {
        settleQueuedMessage(queuedMessageId)
        setCommandError(null)
        return
      }
      setCommandError(isTransportConnectionError(message) ? null : message)
      throw error
    }
  }, [activeChatId, settleQueuedMessage, socket])

  const handleInterruptQueuedMessage = useCallback(async (queuedMessageId: string) => {
    if (!activeChatId) return
    try {
      await socket.command({ type: "message.interrupt", chatId: activeChatId, queuedMessageId })
      // An interrupt command only ACKs after the server has accepted this
      // message as a new turn. Hide the queue row immediately; the next chat
      // snapshot reconciles the durable queue state in the background.
      settleQueuedMessage(queuedMessageId)
      setCommandError(null)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (isQueuedMessageNotFoundError(message)) {
        settleQueuedMessage(queuedMessageId)
        setCommandError(null)
        return
      }
      setCommandError(isTransportConnectionError(message) ? null : message)
      throw error
    }
  }, [activeChatId, settleQueuedMessage, socket])

  const handleEditQueuedMessage = useCallback(async (queuedMessageId: string, content: string) => {
    if (!activeChatId) return
    try {
      await socket.command({ type: "message.edit", chatId: activeChatId, queuedMessageId, content })
      setCommandError(null)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (isQueuedMessageNotFoundError(message)) {
        settleQueuedMessage(queuedMessageId)
        setCommandError(null)
        return
      }
      setCommandError(isTransportConnectionError(message) ? null : message)
      throw error
    }
  }, [activeChatId, settleQueuedMessage, socket])

  const handleRemoveQueuedMessage = useCallback(async (queuedMessageId: string) => {
    if (!activeChatId) return
    try {
      await socket.command({
        type: "message.dequeue",
        chatId: activeChatId,
        queuedMessageId,
      })
      settleQueuedMessage(queuedMessageId)
      setCommandError(null)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (isQueuedMessageNotFoundError(message)) {
        settleQueuedMessage(queuedMessageId)
        setCommandError(null)
        return
      }
      setCommandError(isTransportConnectionError(message) ? null : message)
      throw error
    }
  }, [activeChatId, settleQueuedMessage, socket])

  const handleCancel = useCallback(async () => {
    if (!activeChatId) return
    try {
      await socket.command({ type: "chat.cancel", chatId: activeChatId })
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
    }
  }, [activeChatId, socket])

  const handleStopDraining = useCallback(async () => {
    if (!activeChatId) return
    try {
      await socket.command({ type: "chat.stopDraining", chatId: activeChatId })
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
    }
  }, [activeChatId, socket])

  const handleRenameChat = useCallback(async (chat: SidebarChatRow) => {
    const title = await dialog.prompt({
      title: "Rename Chat",
      initialValue: chat.title,
      confirmLabel: "Rename",
    })
    if (!title || title === chat.title) return
    try {
      await socket.command({ type: "chat.rename", chatId: chat.chatId, title })
      setCommandError(null)
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
    }
  }, [dialog, socket])

  const handleRenameProject = useCallback(async (projectId: string, sidebarTitle: string | undefined, realTitle: string) => {
    const title = await dialog.prompt({
      title: "Rename Project",
      description: "This only changes the sidebar name. The folder path on disk stays the same.",
      initialValue: sidebarTitle ?? "",
      placeholder: realTitle,
      allowEmpty: true,
      resetLabel: "Reset",
      resetValue: "",
      confirmLabel: "Rename",
    })
    if (title === null || title === (sidebarTitle ?? "")) return
    try {
      await socket.command({ type: "project.rename", projectId, title })
      setCommandError(null)
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
    }
  }, [dialog, socket])

  const handleDeleteChat = useCallback(async (chat: SidebarChatRow) => {
    const confirmed = await dialog.confirm({
      title: "Delete Chat",
      description: `Delete "${chat.title}"? This cannot be undone.`,
      confirmLabel: "Delete",
      confirmVariant: "destructive",
    })
    if (!confirmed) return
    try {
      await socket.command({ type: "chat.delete", chatId: chat.chatId })
      if (chat.chatId === activeChatId) {
        const nextChatId = getNewestRemainingChatId(sidebarProjectGroups, chat.chatId)
        navigate(nextChatId ? chatRoute(nextChatId) : "/")
      }
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
    }
  }, [activeChatId, dialog, navigate, sidebarProjectGroups, socket])

  const handleArchiveChat = useCallback(async (chat: SidebarChatRow) => {
    if (pendingArchiveChatIdsRef.current.has(chat.chatId)) return
    pendingArchiveChatIdsRef.current.add(chat.chatId)
    setPendingArchiveChatIds(new Set(pendingArchiveChatIdsRef.current))
    try {
      setCommandError(null)
      await socket.command({ type: "chat.archive", chatId: chat.chatId })
      if (chat.chatId === activeChatId) {
        const nextChatId = getNewestRemainingChatId(sidebarProjectGroups, chat.chatId)
        navigate(nextChatId ? chatRoute(nextChatId) : "/")
      }
      setCommandError(null)
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
    } finally {
      pendingArchiveChatIdsRef.current.delete(chat.chatId)
      setPendingArchiveChatIds(new Set(pendingArchiveChatIdsRef.current))
    }
  }, [activeChatId, navigate, sidebarProjectGroups, socket])

  const handlePinChat = useCallback(async (chat: SidebarChatRow) => {
    try {
      setCommandError(null)
      await socket.command({ type: "chat.pin", chatId: chat.chatId, pinned: !chat.pinned })
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
    }
  }, [socket])

  const handleReorderPinnedChats = useCallback(async (chatIds: string[]) => {
    try {
      setCommandError(null)
      await socket.command({ type: "chat.reorderPinned", chatIds })
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
      throw error
    }
  }, [socket])

  const handleOpenArchivedChat = useCallback(async (chatId: string) => {
    try {
      setPendingChatId(chatId)
      await socket.command({ type: "chat.unarchive", chatId })
      navigate(chatRoute(chatId))
      setCommandError(null)
    } catch (error) {
      setPendingChatId(null)
      setCommandError(error instanceof Error ? error.message : String(error))
    }
  }, [navigate, socket])

  const handleHideProject = useCallback(async (projectId: string) => {
    try {
      await socket.command({ type: "project.remove", projectId })
      useTerminalLayoutStore.getState().clearProject(projectId)
      useRightSidebarStore.getState().clearProject(projectId)
      if (runtime?.projectId === projectId) {
        navigate("/")
      }
      setCommandError(null)
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
    }
  }, [navigate, runtime?.projectId, socket])

  const handleReorderProjectGroups = useCallback(async (projectIds: string[]) => {
    setOptimisticSidebarProjectOrder(projectIds)
    try {
      await socket.command({ type: "sidebar.reorderProjectGroups", projectIds })
      setCommandError(null)
    } catch (error) {
      setOptimisticSidebarProjectOrder(null)
      setCommandError(error instanceof Error ? error.message : String(error))
    }
  }, [socket])

  const openExternal = useCallback(async (command: {
    action: OpenExternalAction
    localPath: string
    line?: number
    column?: number
    editor?: EditorOpenSettings
  }) => {
    const preferences = useTerminalPreferencesStore.getState()
    setCommandError(null)
    await socket.command({
      type: "system.openExternal",
      ...command,
      editor: command.action === "open_editor"
        ? command.editor ?? {
            preset: preferences.editorPreset,
            commandTemplate: preferences.editorCommandTemplate,
          }
        : undefined,
    })
  }, [socket])

  const handleOpenExternal = useCallback(async (action: OpenExternalAction, editor?: EditorOpenSettings) => {
    const localPath = runtime?.localPath ?? localProjects?.projects[0]?.localPath ?? sidebarProjectGroups[0]?.localPath
    if (!localPath) return
    try {
      await openExternal({
        action,
        localPath,
        editor,
      })
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
    }
  }, [localProjects?.projects, openExternal, runtime?.localPath, sidebarProjectGroups])

  const handleCopyPath = useCallback(async (localPath: string) => {
    try {
      if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
        throw new Error("Clipboard is not available")
      }
      await navigator.clipboard.writeText(localPath)
      setCommandError(null)
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
    }
  }, [])

  const handleOpenLocalLink = useCallback(async (
    target: OpenLocalLinkTarget,
    action: OpenExternalAction = "open_editor",
    editor?: EditorOpenSettings,
  ) => {
    try {
      await openExternal({
        action,
        localPath: target.path,
        line: target.line,
        column: target.column,
        editor,
      })
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
    }
  }, [openExternal])

  const handleOpenExternalPath = useCallback(async (action: "open_finder" | "open_editor", localPath: string) => {
    try {
      await openExternal({
        action,
        localPath,
      })
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
    }
  }, [openExternal])

  const handleRestoreCheckpoint = useCallback(async (checkpointId: string, mode: CheckpointRestoreMode, promptContent: string) => {
    if (!activeChatId) {
      return null
    }
    const confirmed = await dialog.confirm({
      title: "Restore checkpoint?",
      description: "Abolqasem will create a safety checkpoint first, then restore the selected code and/or chat state.",
      confirmLabel: "Restore",
      cancelLabel: "Cancel",
      confirmVariant: "destructive",
    })
    if (!confirmed) {
      return null
    }
    try {
      const result = await socket.command<CheckpointRestoreResult>({
        type: "chat.restoreCheckpoint",
        chatId: activeChatId,
        checkpointId,
        mode,
      })
      if (result.chatRestored) {
        useChatInputStore.getState().setDraft(activeChatId, promptContent)
        useChatInputStore.getState().clearAttachmentDrafts(activeChatId)
        setOlderHistoryEntries([])
        window.dispatchEvent(new Event(RESTORE_CHAT_INPUT_FOCUS_EVENT))
      }
      setCommandError(null)
      return result
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
      return null
    }
  }, [activeChatId, dialog, socket])

  const handleCompose = useCallback(() => {
    const projectId = selectedProjectId ?? sidebarProjectGroups[0]?.groupKey ?? null
    if (projectId) {
      void startChatForProjectId(projectId)
      return
    }

    if (fallbackLocalProjectPath) {
      void startChatFromIntent({ kind: "local_path", localPath: fallbackLocalProjectPath })
      return
    }

    navigate("/")
  }, [fallbackLocalProjectPath, navigate, selectedProjectId, sidebarProjectGroups, startChatForProjectId, startChatFromIntent])

  const openSidebar = useCallback(() => setSidebarOpen(true), [])
  const closeSidebar = useCallback(() => setSidebarOpen(false), [])
  const collapseSidebar = useCallback(() => setSidebarCollapsed(true), [])
  const expandSidebar = useCallback(() => setSidebarCollapsed(false), [])
  const openAddProjectModal = useCallback(() => setAddProjectModalOpen(true), [])
  const closeAddProjectModal = useCallback(() => setAddProjectModalOpen(false), [])

  const handleAskUserQuestion = useCallback(async (
    toolUseId: string,
    questions: AskUserQuestionItem[],
    answers: AskUserQuestionAnswerMap
  ) => {
    if (!activeChatId) return
    try {
      await socket.command({
        type: "chat.respondTool",
        chatId: activeChatId,
        toolUseId,
        result: { questions, answers },
      })
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
    }
  }, [activeChatId, socket])

  const handleApprovalRequest = useCallback(async (toolUseId: string, decision: ApprovalDecision) => {
    if (!activeChatId) throw new Error("No active chat")
    try {
      await socket.command({
        type: "chat.respondTool",
        chatId: activeChatId,
        toolUseId,
        result: { decision },
      })
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
      throw error
    }
  }, [activeChatId, socket])

  const refreshChatTranscript = useCallback(async () => {
    if (!activeChatId) return null
    const snapshot = await fetchFreshChatTranscript(activeChatId)
    if (!snapshot || snapshot.runtime.chatId !== activeChatId) {
      throw new Error("The refreshed transcript did not match the active chat")
    }
    setChatSnapshot((current) =>
      sameChatSnapshotCore(current, snapshot) ? current : snapshot,
    )
    setHistoryCursor(snapshot.history.olderCursor ?? null)
    setHasOlderHistory(snapshot.history.hasOlder ?? false)
    setChatReady(true)
    setCommandError(null)
    return snapshot
  }, [activeChatId])

  const handleExitPlanMode = useCallback(async (toolUseId: string, confirmed: boolean, clearContext?: boolean, message?: string) => {
    if (!activeChatId) return
    try {
      if (confirmed) {
        await socket.command({ type: "chat.setPlanMode", chatId: activeChatId, planMode: false })
        useChatPreferencesStore.getState().setChatComposerPlanMode(activeChatId, false)
      }
      await socket.command({
        type: "chat.respondTool",
        chatId: activeChatId,
        toolUseId,
        result: {
          confirmed,
          ...(clearContext ? { clearContext: true } : {}),
          ...(message ? { message } : {}),
        },
      })
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
    }
  }, [activeChatId, socket])

  return {
    socket,
    activeChatId,
    activeProjectId,
    sidebarData: resolvedSidebarData,
    localProjects,
    updateSnapshot,
    chatSnapshot,
    chatDiffSnapshot,
    keybindings,
    appSettings,
    llmProvider,
    connectionStatus,
    sidebarReady,
    chatReady,
    localProjectsReady,
    commandError,
    sessionForkOperation,
    creatingChatProjectId,
    pendingArchiveChatIds,
    startingLocalPath,
    sidebarOpen,
    sidebarCollapsed,
    messages,
    queuedMessages: visibleQueuedMessages,
    previousPrompt,
    latestToolIds,
    runtime,
    runtimeStatus: effectiveRuntimeStatus,
    isHistoryLoading,
    hasOlderHistory,
    availableProviders,
    isProcessing,
    canCancel,
    isDraining,
    navbarLocalPath,
    editorLabel,
    hasSelectedProject,
    addProjectModalOpen,
    openSidebar,
    closeSidebar,
    collapseSidebar,
    expandSidebar,
    openAddProjectModal,
    closeAddProjectModal,
    loadOlderHistory,
    loadHistoryAround,
    handleCreateChat,
    handleForkChat,
    handleConvertChat,
    handleOpenLocalProject,
    handleCreateProject,
    handleCheckForUpdates,
    handleInstallUpdate,
    handleReadAppSettings,
    handleWriteAppSettings,
    handleReadLlmProvider,
    handleWriteLlmProvider,
    handleValidateLlmProvider,
    handleSignOut,
    handleSend,
    handleSteerQueuedMessage,
    handleInterruptQueuedMessage,
    handleEditQueuedMessage,
    handleRemoveQueuedMessage,
    handleCancel,
    handleStopDraining,
    handleRenameChat,
    handleRenameProject,
    handleArchiveChat,
    handlePinChat,
    handleReorderPinnedChats,
    handleOpenArchivedChat,
    handleDeleteChat,
    handleHideProject,
    handleReorderProjectGroups,
    handleCopyPath,
    handleOpenExternal,
    handleOpenExternalPath,
    handleOpenLocalLink,
    handleCompose,
    handleAskUserQuestion,
    handleApprovalRequest,
    refreshChatTranscript,
    handleExitPlanMode,
    handleRestoreCheckpoint,
  }
}
