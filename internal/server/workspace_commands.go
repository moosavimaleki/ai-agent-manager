package server

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"abolqasem/internal/parser"
	"abolqasem/internal/state"
	"abolqasem/internal/workspace/events"
	"abolqasem/internal/workspace/readmodels"
	"abolqasem/internal/workspace/transcript"
)

// A visible chat is refreshed once per second so that a session being worked
// on in another Codex client feels live. Parsing a native JSONL transcript is
// linear in its size, though, so avoid re-reading an unchanged file for every
// browser refresh. A stat is cheap and the cache is deliberately small: it is
// only an optimisation for currently viewed native transcripts, not storage.
const workspaceNativeHistoryCacheMaxEntries = 32

type workspaceNativeHistoryCacheKey struct {
	agent     string
	sessionID string
	path      string
	limit     int
}

type workspaceNativeHistoryCacheEntry struct {
	modifiedAt int64
	size       int64
	page       map[string]any
	lastAccess time.Time
}

var workspaceNativeHistoryCache = struct {
	sync.Mutex
	items map[workspaceNativeHistoryCacheKey]workspaceNativeHistoryCacheEntry
}{items: make(map[workspaceNativeHistoryCacheKey]workspaceNativeHistoryCacheEntry)}

func workspaceCreateProject(raw json.RawMessage) (readmodels.ProjectRecord, error) {
	var payload struct {
		LocalPath string `json:"localPath"`
		Title     string `json:"title"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return readmodels.ProjectRecord{}, err
	}
	return workspaceOpenProject(payload.LocalPath, payload.Title)
}

func workspaceRenameProject(raw json.RawMessage) error {
	var payload struct {
		ProjectID string `json:"projectId"`
		Title     string `json:"title"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return err
	}
	if _, err := workspaceProjectRequired(payload.ProjectID); err != nil {
		return err
	}
	title := strings.TrimSpace(payload.Title)
	event, err := events.New(events.TypeProjectSidebarRenamed, map[string]any{
		"projectId": payload.ProjectID,
		"title":     &title,
	})
	if err != nil {
		return err
	}
	return workspaceStore().Append(events.StreamProjects, event)
}

func workspaceRemoveProject(raw json.RawMessage) error {
	var payload struct {
		ProjectID string `json:"projectId"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return err
	}
	if _, err := workspaceProjectRequired(payload.ProjectID); err != nil {
		return err
	}
	event, err := events.New(events.TypeProjectRemoved, map[string]any{"projectId": payload.ProjectID})
	if err != nil {
		return err
	}
	return workspaceStore().Append(events.StreamProjects, event)
}

func workspaceReorderProjectGroups(raw json.RawMessage) error {
	var payload struct {
		ProjectIDs []string `json:"projectIds"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return err
	}
	state, err := workspaceStore().LoadState()
	if err != nil {
		return err
	}
	active := make(map[string]bool)
	for id, project := range state.ProjectsByID {
		if project.DeletedAt == 0 {
			active[id] = true
		}
	}
	seen := make(map[string]bool, len(payload.ProjectIDs))
	for _, id := range payload.ProjectIDs {
		if !active[id] {
			return errors.New("projectIds contains an unknown or deleted project")
		}
		if seen[id] {
			return errors.New("projectIds contains a duplicate project")
		}
		seen[id] = true
	}
	if len(seen) != len(active) {
		return errors.New("projectIds must include every active project")
	}
	event, err := events.New(events.TypeProjectSidebarReordered, map[string]any{"projectIds": payload.ProjectIDs})
	if err != nil {
		return err
	}
	return workspaceStore().Append(events.StreamProjects, event)
}

func workspaceRenameChat(raw json.RawMessage) (string, error) {
	var payload struct {
		ChatID string `json:"chatId"`
		Title  string `json:"title"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return "", err
	}
	chatID, err := workspaceMaterializeImportedChatIfNeeded(payload.ChatID)
	if err != nil {
		return "", err
	}
	payload.ChatID = chatID
	if _, _, err := workspaceChatProjectRequired(payload.ChatID); err != nil {
		return "", err
	}
	title := strings.TrimSpace(payload.Title)
	if title == "" {
		return "", errors.New("title is required")
	}
	event, err := events.New(events.TypeChatRenamed, map[string]any{"chatId": payload.ChatID, "title": title})
	if err != nil {
		return "", err
	}
	if err := workspaceStore().Append(events.StreamChats, event); err != nil {
		return "", err
	}
	return payload.ChatID, nil
}

func workspaceArchiveChat(raw json.RawMessage) (string, error) {
	return workspaceMarkChat(raw, events.TypeChatArchived)
}

func workspaceUnarchiveChat(raw json.RawMessage) (string, error) {
	return workspaceMarkChat(raw, events.TypeChatUnarchived)
}

func workspacePinChat(raw json.RawMessage) (string, error) {
	var payload struct {
		ChatID string `json:"chatId"`
		Pinned bool   `json:"pinned"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return "", err
	}
	chatID, err := workspaceMaterializeImportedChatIfNeeded(payload.ChatID)
	if err != nil {
		return "", err
	}
	if _, _, err := workspaceChatProjectRequired(chatID); err != nil {
		return "", err
	}
	event, err := events.New(events.TypeChatPinned, map[string]any{"chatId": chatID, "pinned": payload.Pinned})
	if err != nil {
		return "", err
	}
	if err := workspaceStore().Append(events.StreamChats, event); err != nil {
		return "", err
	}
	return chatID, nil
}

func workspaceReorderPinnedChats(raw json.RawMessage) error {
	var payload struct {
		ChatIDs []string `json:"chatIds"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return err
	}
	state, err := workspaceStore().LoadState()
	if err != nil {
		return err
	}
	pinned := make(map[string]bool)
	for chatID, chat := range state.ChatsByID {
		if chat.Pinned && chat.DeletedAt == 0 && chat.ArchivedAt == 0 {
			pinned[chatID] = true
		}
	}
	if len(payload.ChatIDs) != len(pinned) {
		return errors.New("chatIds must include every pinned chat")
	}
	seen := make(map[string]bool, len(payload.ChatIDs))
	for _, chatID := range payload.ChatIDs {
		if !pinned[chatID] {
			return errors.New("chatIds contains an unknown or unpinned chat")
		}
		if seen[chatID] {
			return errors.New("chatIds contains a duplicate chat")
		}
		seen[chatID] = true
	}
	event, err := events.New(events.TypeChatPinnedReordered, map[string]any{"chatIds": payload.ChatIDs})
	if err != nil {
		return err
	}
	return workspaceStore().Append(events.StreamChats, event)
}

func workspaceDeleteChat(raw json.RawMessage) (string, error) {
	var payload struct {
		ChatID string `json:"chatId"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return "", err
	}
	chatID, err := workspaceMaterializeImportedChatIfNeeded(payload.ChatID)
	if err != nil {
		return "", err
	}
	payload.ChatID = chatID
	if err := workspaceAgentCoordinator().Cancel(payload.ChatID); err != nil {
		return "", err
	}
	return workspaceMarkChatID(payload.ChatID, events.TypeChatDeleted)
}

func workspaceForkChat(raw json.RawMessage) (map[string]any, string, error) {
	var payload struct {
		ChatID string `json:"chatId"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return nil, "", err
	}
	chatID, err := workspaceMaterializeImportedChatIfNeeded(payload.ChatID)
	if err != nil {
		return nil, "", err
	}
	payload.ChatID = chatID
	chat, project, err := workspaceChatProjectRequired(payload.ChatID)
	if err != nil {
		return nil, "", err
	}
	fork, err := workspaceCreateChat(project.ID)
	if err != nil {
		return nil, "", err
	}
	title := strings.TrimSpace(chat.Title)
	if title == "" {
		title = "Forked Chat"
	} else {
		title += " (Fork)"
	}
	renameEvent, err := events.New(events.TypeChatRenamed, map[string]any{"chatId": fork.ID, "title": title})
	if err != nil {
		return nil, "", err
	}
	if err := workspaceStore().Append(events.StreamChats, renameEvent); err != nil {
		return nil, "", err
	}
	if provider := derefWorkspaceString(chat.Provider); strings.TrimSpace(provider) != "" {
		providerEvent, err := events.New(events.TypeChatProviderSet, map[string]any{"chatId": fork.ID, "provider": provider})
		if err != nil {
			return nil, "", err
		}
		if err := workspaceStore().Append(events.StreamChats, providerEvent); err != nil {
			return nil, "", err
		}
	}
	forkToken := firstNonEmpty(chat.NativeSessionID, derefWorkspaceString(chat.PendingForkSessionToken), derefWorkspaceString(chat.SessionToken))
	if forkToken != "" {
		if err := appendWorkspaceStoreEvent(workspaceStore(), events.StreamTurns, events.TypePendingForkSessionTokenSet, time.Now().UnixMilli(), map[string]any{
			"chatId":                  fork.ID,
			"pendingForkSessionToken": &forkToken,
		}); err != nil {
			return nil, "", err
		}
	}
	if chat.NativeSessionID != "" || chat.NativeTranscriptPath != "" || chat.LastSummary != "" {
		if err := appendWorkspaceStoreEvent(workspaceStore(), events.StreamChats, events.TypeChatRuntimeSet, time.Now().UnixMilli(), map[string]any{
			"chatId":               fork.ID,
			"nativeSessionId":      chat.NativeSessionID,
			"nativeTranscriptPath": chat.NativeTranscriptPath,
			"lastSummary":          chat.LastSummary,
		}); err != nil {
			return nil, "", err
		}
	}
	return map[string]any{"chatId": fork.ID}, fork.ID, nil
}

func workspaceMarkChat(raw json.RawMessage, eventType string) (string, error) {
	var payload struct {
		ChatID string `json:"chatId"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return "", err
	}
	return workspaceMarkChatID(payload.ChatID, eventType)
}

func workspaceMarkChatID(chatID string, eventType string) (string, error) {
	normalizedChatID, err := workspaceMaterializeImportedChatIfNeeded(chatID)
	if err != nil {
		return "", err
	}
	chatID = normalizedChatID
	if _, _, err := workspaceChatProjectRequired(chatID); err != nil {
		return "", err
	}
	event, err := events.New(eventType, map[string]any{"chatId": chatID})
	if err != nil {
		return "", err
	}
	if err := workspaceStore().Append(events.StreamChats, event); err != nil {
		return "", err
	}
	return chatID, nil
}

func workspaceLoadChatHistory(raw json.RawMessage) (map[string]any, error) {
	var payload struct {
		ChatID       string `json:"chatId"`
		BeforeCursor string `json:"beforeCursor"`
		Limit        int    `json:"limit"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return nil, err
	}
	if payload.Limit <= 0 {
		payload.Limit = 50
	}
	if payload.Limit > 500 {
		payload.Limit = 500
	}
	if workspaceStoredChatExists(payload.ChatID) {
		return workspaceLoadStoredChatHistory(payload.ChatID, payload.BeforeCursor, payload.Limit)
	}
	if meta, ok := workspaceLegacySessionByChatID(payload.ChatID); ok {
		return workspaceLoadLegacyChatHistory(meta, payload.BeforeCursor, payload.Limit)
	}
	return workspaceLoadStoredChatHistory(payload.ChatID, payload.BeforeCursor, payload.Limit)
}

func workspaceLoadChatHistoryAround(raw json.RawMessage) (map[string]any, error) {
	var payload struct {
		ChatID       string `json:"chatId"`
		TargetCursor string `json:"targetCursor"`
		Limit        int    `json:"limit"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return nil, err
	}
	if payload.Limit <= 0 {
		payload.Limit = 80
	}
	if payload.Limit > 500 {
		payload.Limit = 500
	}
	if strings.TrimSpace(payload.TargetCursor) == "" {
		return nil, errors.New("targetCursor is required")
	}
	if workspaceStoredChatExists(payload.ChatID) {
		return workspaceLoadStoredChatHistoryAround(payload.ChatID, payload.TargetCursor, payload.Limit)
	}
	if meta, ok := workspaceLegacySessionByChatID(payload.ChatID); ok {
		return workspaceLoadLegacyChatHistoryAround(meta, payload.TargetCursor, payload.Limit)
	}
	return workspaceLoadStoredChatHistoryAround(payload.ChatID, payload.TargetCursor, payload.Limit)
}

type workspaceTranscriptIndexItem struct {
	ID              string `json:"id"`
	Sequence        int    `json:"sequence"`
	Role            string `json:"role"`
	EstimatedHeight int    `json:"estimatedHeight,omitempty"`
	HasError        bool   `json:"hasError,omitempty"`
	HasCode         bool   `json:"hasCode,omitempty"`
	IsPinned        bool   `json:"isPinned,omitempty"`
	Preview         string `json:"preview,omitempty"`
}

func workspaceReadChatTranscriptIndex(raw json.RawMessage) (map[string]any, error) {
	var payload struct {
		ChatID string `json:"chatId"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return nil, err
	}

	chatID := strings.TrimSpace(payload.ChatID)
	if chatID == "" {
		return nil, errors.New("chatId is required")
	}

	if meta, ok := workspaceLegacySessionByChatID(chatID); ok && !workspaceStoredChatExists(chatID) {
		imported, err := workspaceImportedLegacySession(meta)
		if err != nil && !workspaceLegacyTranscriptUnavailable(err) {
			return nil, err
		}
		return map[string]any{
			"chatId": chatID,
			"items":  buildWorkspaceTranscriptIndex(imported.Transcript.Messages),
		}, nil
	}

	if _, _, err := workspaceChatProjectRequired(chatID); err != nil {
		return nil, err
	}
	if meta, ok, err := workspaceNativeTranscriptMetaForChat(chatID); err != nil {
		return nil, err
	} else if ok {
		items, err := workspaceNativeTranscriptIndex(meta)
		if err != nil {
			return nil, err
		}
		return map[string]any{
			"chatId": chatID,
			"items":  items,
		}, nil
	}

	entries, err := workspaceChatMessages(chatID)
	if err != nil {
		return nil, err
	}

	return map[string]any{
		"chatId": chatID,
		"items":  buildWorkspaceTranscriptIndex(entries),
	}, nil
}

func buildWorkspaceTranscriptIndex(entries []readmodels.TranscriptEntry) []workspaceTranscriptIndexItem {
	items := make([]workspaceTranscriptIndexItem, 0, len(entries))
	pendingToolItemIndex := map[string]int{}

	for _, entry := range entries {
		kind := workspaceEntryString(entry, "kind")
		if kind == "tool_result" {
			toolID := workspaceEntryString(entry, "toolId")
			index, ok := pendingToolItemIndex[toolID]
			if ok && index >= 0 && index < len(items) {
				items[index].HasError = items[index].HasError || workspaceEntryBool(entry, "isError")
			}
			continue
		}

		item, ok := workspaceTranscriptIndexItemFromEntry(entry, len(items))
		if !ok {
			continue
		}
		items = append(items, item)

		if kind == "tool_call" {
			toolID := workspaceEntryToolID(entry)
			if toolID != "" {
				pendingToolItemIndex[toolID] = len(items) - 1
			}
		}
	}

	return items
}

func workspaceNativeTranscriptIndex(meta state.SessionMeta) ([]workspaceTranscriptIndexItem, error) {
	items := []workspaceTranscriptIndexItem{}
	err := parser.StreamSearchableMessages(meta.Agent, meta.SessionID, meta.TranscriptPath, func(message parser.SearchableMessage) bool {
		item, ok := workspaceTranscriptIndexItemFromSearchable(message, len(items))
		if ok {
			items = append(items, item)
		}
		return true
	})
	if err != nil {
		return nil, err
	}
	return items, nil
}

func workspaceTranscriptIndexItemFromSearchable(message parser.SearchableMessage, sequence int) (workspaceTranscriptIndexItem, bool) {
	role := workspaceSearchableTranscriptRole(message)
	if role == "" {
		return workspaceTranscriptIndexItem{}, false
	}
	text := strings.TrimSpace(message.Text)
	hasCode := workspaceTranscriptHasCode(message.Kind, text)
	return workspaceTranscriptIndexItem{
		ID:              workspaceSearchableCursor(message),
		Sequence:        sequence,
		Role:            role,
		EstimatedHeight: workspaceTranscriptEstimatedHeight(role, text, hasCode),
		HasCode:         hasCode,
		Preview:         workspaceTranscriptPreviewText(text),
	}, true
}

func workspaceSearchableTranscriptRole(message parser.SearchableMessage) string {
	switch strings.ToLower(strings.TrimSpace(message.Role)) {
	case "user":
		return "user"
	case "assistant", "model":
		return "assistant"
	case "tool":
		return "tool"
	case "system":
		return "system"
	default:
		if strings.EqualFold(strings.TrimSpace(message.Kind), "tool") {
			return "tool"
		}
		return ""
	}
}

func workspaceTranscriptIndexItemFromEntry(entry readmodels.TranscriptEntry, sequence int) (workspaceTranscriptIndexItem, bool) {
	if workspaceEntryBool(entry, "hidden") {
		return workspaceTranscriptIndexItem{}, false
	}

	kind := workspaceEntryString(entry, "kind")
	role := workspaceTranscriptIndexRole(kind)
	if role == "" {
		return workspaceTranscriptIndexItem{}, false
	}

	text := workspaceTranscriptIndexText(entry)
	hasCode := workspaceTranscriptHasCode(kind, text)
	return workspaceTranscriptIndexItem{
		ID:              workspaceTranscriptCursor(entry),
		Sequence:        sequence,
		Role:            role,
		EstimatedHeight: workspaceTranscriptEstimatedHeight(role, text, hasCode),
		HasError:        kind == "result" && workspaceEntryBool(entry, "isError"),
		HasCode:         hasCode,
		Preview:         workspaceTranscriptPreviewText(text),
	}, true
}

func workspaceTranscriptIndexRole(kind string) string {
	switch kind {
	case "user_prompt":
		return "user"
	case "assistant_text":
		return "assistant"
	case "tool_call":
		return "tool"
	case "system_init", "account_info", "result", "status", "compact_summary", "context_cleared", "interrupted":
		return "system"
	default:
		return ""
	}
}

func workspaceTranscriptIndexText(entry readmodels.TranscriptEntry) string {
	switch workspaceEntryString(entry, "kind") {
	case "user_prompt":
		return workspaceEntryString(entry, "content")
	case "assistant_text":
		return workspaceEntryString(entry, "text")
	case "system_init":
		return workspaceEntryString(entry, "model")
	case "account_info":
		return workspaceEntryString(entry, "debugRaw")
	case "tool_call":
		return workspaceTranscriptToolSummary(entry)
	case "result":
		return workspaceEntryString(entry, "result")
	case "status":
		return workspaceEntryString(entry, "status")
	case "compact_summary":
		return workspaceEntryString(entry, "summary")
	default:
		return workspaceEntryString(entry, "debugRaw")
	}
}

func workspaceTranscriptToolSummary(entry readmodels.TranscriptEntry) string {
	tool, ok := entry["tool"].(map[string]any)
	if !ok {
		return ""
	}

	parts := make([]string, 0, 3)
	if name := workspaceAnyString(tool["toolName"]); name != "" {
		parts = append(parts, name)
	}
	if input, ok := tool["input"].(map[string]any); ok {
		for _, key := range []string{"command", "description", "filePath", "pattern", "text", "summary", "status"} {
			if value := workspaceAnyString(input[key]); value != "" {
				parts = append(parts, value)
				break
			}
		}
	}

	return strings.TrimSpace(strings.Join(parts, "\n"))
}

func workspaceTranscriptHasCode(kind string, text string) bool {
	if strings.Contains(text, "```") {
		return true
	}
	if kind == "tool_call" {
		return strings.Contains(text, "\n") || strings.Contains(text, " --") || strings.Contains(text, "/")
	}
	return false
}

func workspaceTranscriptEstimatedHeight(role string, text string, hasCode bool) int {
	base := 28
	switch role {
	case "user":
		base = 36
	case "assistant":
		base = 44
	case "tool":
		base = 38
	case "system":
		base = 30
	}

	if strings.TrimSpace(text) == "" {
		return base
	}

	runeCount := utf8.RuneCountInString(text)
	lineCount := strings.Count(text, "\n") + 1
	if wrappedLines := (runeCount + 87) / 88; wrappedLines > lineCount {
		lineCount = wrappedLines
	}
	height := base + (lineCount-1)*18
	if hasCode {
		height += 22
	}
	if height > 220 {
		return 220
	}
	return height
}

func workspaceTranscriptPreviewText(text string) string {
	if strings.TrimSpace(text) == "" {
		return ""
	}

	normalized := strings.Join(strings.Fields(text), " ")
	runes := []rune(normalized)
	if len(runes) <= 140 {
		return normalized
	}
	return string(runes[:140]) + "…"
}

func workspaceEntryBool(entry readmodels.TranscriptEntry, key string) bool {
	value, ok := entry[key].(bool)
	return ok && value
}

func workspaceAnyString(value any) string {
	typed, ok := value.(string)
	if !ok {
		return ""
	}
	return strings.TrimSpace(typed)
}

func workspaceLoadStoredChatHistory(chatID string, beforeCursor string, limit int) (map[string]any, error) {
	chat, _, err := workspaceChatProjectRequired(chatID)
	if err != nil {
		return nil, err
	}
	if meta, ok, err := workspaceNativeTranscriptMetaForChat(chatID); err != nil {
		return nil, err
	} else if ok {
		return workspaceLoadNativeChatHistory(meta, beforeCursor, limit)
	}
	if workspaceChatHasTmuxRuntime(chat) {
		return map[string]any{
			"messages":    []readmodels.TranscriptEntry{},
			"hasOlder":    false,
			"olderCursor": nil,
		}, nil
	}
	entries, err := workspaceChatMessages(chatID)
	if err != nil {
		return nil, err
	}
	end := len(entries)
	if beforeCursor != "" {
		for index, entry := range entries {
			if workspaceTranscriptCursor(entry) == beforeCursor {
				end = index
				break
			}
		}
	}
	start := end - limit
	if start < 0 {
		start = 0
	}
	page := entries[start:end]
	var olderCursor *string
	if start > 0 && len(page) > 0 {
		// Cursors are exclusive: the next request loads entries *before* this
		// page's first entry. Returning entries[start-1] skipped that entry on
		// every page boundary.
		cursor := workspaceTranscriptCursor(page[0])
		olderCursor = &cursor
	}
	return map[string]any{
		"messages":    page,
		"hasOlder":    start > 0,
		"olderCursor": olderCursor,
	}, nil
}

func workspaceLoadStoredChatHistoryAround(chatID string, targetCursor string, limit int) (map[string]any, error) {
	chat, _, err := workspaceChatProjectRequired(chatID)
	if err != nil {
		return nil, err
	}
	if meta, ok, err := workspaceNativeTranscriptMetaForChat(chatID); err != nil {
		return nil, err
	} else if ok {
		return workspaceLoadNativeChatHistoryAround(meta, targetCursor, limit)
	}
	if workspaceChatHasTmuxRuntime(chat) {
		return map[string]any{
			"messages":    []readmodels.TranscriptEntry{},
			"hasOlder":    false,
			"olderCursor": nil,
			"targetFound": false,
		}, nil
	}
	entries, err := workspaceChatMessages(chatID)
	if err != nil {
		return nil, err
	}
	messages, hasOlder, olderCursor, targetFound := workspaceSliceTranscriptEntriesAround(entries, targetCursor, limit)
	return map[string]any{
		"messages":    messages,
		"hasOlder":    hasOlder,
		"olderCursor": olderCursor,
		"targetFound": targetFound,
	}, nil
}

func workspaceNativeTranscriptMetaForChat(chatID string) (state.SessionMeta, bool, error) {
	stateSnapshot, err := workspaceStore().LoadStateLight()
	if err != nil {
		return state.SessionMeta{}, false, err
	}
	chat, ok := stateSnapshot.ChatsByID[strings.TrimSpace(chatID)]
	if !ok || chat.DeletedAt != 0 || strings.TrimSpace(chat.NativeTranscriptPath) == "" {
		return state.SessionMeta{}, false, nil
	}
	project, ok := stateSnapshot.ProjectsByID[chat.ProjectID]
	if !ok || project.DeletedAt != 0 {
		return state.SessionMeta{}, false, errors.New("project not found")
	}
	meta, ok := workspaceNativeTranscriptMetaForChatRecord(chat, project)
	return meta, ok, nil
}

func workspaceNativeTranscriptMetaForChatRecord(chat readmodels.ChatRecord, project readmodels.ProjectRecord) (state.SessionMeta, bool) {
	if chat.DeletedAt != 0 || project.DeletedAt != 0 || strings.TrimSpace(chat.NativeTranscriptPath) == "" {
		return state.SessionMeta{}, false
	}
	meta := state.SessionMeta{
		Agent:          firstNonEmpty(derefWorkspaceString(chat.Provider), "codex"),
		SessionID:      firstNonEmpty(chat.NativeSessionID, derefWorkspaceString(chat.SessionToken), chat.ID),
		TranscriptPath: chat.NativeTranscriptPath,
		Cwd:            project.LocalPath,
		ProjectName:    project.Title,
	}
	if appState, err := workspaceLoadLegacyState(); err == nil {
		if discovered, ok := appState.Sessions[state.SessionKey(meta.Agent, meta.SessionID)]; ok && strings.TrimSpace(discovered.TranscriptPath) != "" && !discovered.MetadataOnly {
			meta.TranscriptPath = discovered.TranscriptPath
		}
	}
	return meta, true
}

func workspaceLoadNativeChatHistory(meta state.SessionMeta, beforeCursor string, limit int) (map[string]any, error) {
	if limit <= 0 {
		limit = legacyDefaultRecentLimit
	}
	cursor := strings.TrimSpace(beforeCursor)
	cacheKey, modifiedAt, size, cacheable := workspaceNativeHistoryCacheFingerprint(meta, limit, cursor)
	if cacheable {
		if page, ok := workspaceNativeHistoryCacheLookup(cacheKey, modifiedAt, size); ok {
			return page, nil
		}
	}
	window := []readmodels.TranscriptEntry{}
	hasOlder := false
	var olderCursor *string
	err := parser.StreamSearchableMessages(meta.Agent, meta.SessionID, meta.TranscriptPath, func(message parser.SearchableMessage) bool {
		if cursor != "" && workspaceSearchableMatchesCursor(message, cursor) {
			return false
		}
		if len(window) >= limit {
			hasOlder = true
			window = window[1:]
		}
		window = append(window, workspaceTranscriptEntryFromSearchable(message))
		return true
	})
	if err != nil {
		return nil, err
	}
	if hasOlder && len(window) > 0 {
		cursor := workspaceTranscriptCursor(window[0])
		olderCursor = &cursor
	}
	page := map[string]any{
		"messages":    window,
		"hasOlder":    hasOlder,
		"olderCursor": olderCursor,
	}
	if cacheable {
		workspaceNativeHistoryCacheStore(cacheKey, modifiedAt, size, page)
	}
	return workspaceCloneNativeHistoryPage(page), nil
}

func workspaceNativeHistoryCacheFingerprint(meta state.SessionMeta, limit int, cursor string) (workspaceNativeHistoryCacheKey, int64, int64, bool) {
	if cursor != "" || strings.TrimSpace(meta.TranscriptPath) == "" {
		return workspaceNativeHistoryCacheKey{}, 0, 0, false
	}
	info, err := os.Stat(meta.TranscriptPath)
	if err != nil || !info.Mode().IsRegular() {
		return workspaceNativeHistoryCacheKey{}, 0, 0, false
	}
	return workspaceNativeHistoryCacheKey{
		agent:     strings.ToLower(strings.TrimSpace(meta.Agent)),
		sessionID: strings.TrimSpace(meta.SessionID),
		path:      filepath.Clean(meta.TranscriptPath),
		limit:     limit,
	}, info.ModTime().UnixNano(), info.Size(), true
}

func workspaceNativeHistoryCacheLookup(key workspaceNativeHistoryCacheKey, modifiedAt int64, size int64) (map[string]any, bool) {
	workspaceNativeHistoryCache.Lock()
	defer workspaceNativeHistoryCache.Unlock()
	entry, ok := workspaceNativeHistoryCache.items[key]
	if !ok || entry.modifiedAt != modifiedAt || entry.size != size {
		return nil, false
	}
	entry.lastAccess = time.Now()
	workspaceNativeHistoryCache.items[key] = entry
	return workspaceCloneNativeHistoryPage(entry.page), true
}

// workspaceInvalidateNativeHistoryCacheForChat is deliberately used only for
// an explicit user refresh. The visible-chat poll keeps the cache hot, while a
// user who asks to refresh session text must get a fresh parse even if an
// external writer preserved the file size and timestamp resolution.
func workspaceInvalidateNativeHistoryCacheForChat(chatID string) {
	meta, ok, err := workspaceNativeTranscriptMetaForChat(chatID)
	if err != nil || !ok || strings.TrimSpace(meta.TranscriptPath) == "" {
		return
	}
	path := filepath.Clean(meta.TranscriptPath)
	workspaceNativeHistoryCache.Lock()
	defer workspaceNativeHistoryCache.Unlock()
	for key := range workspaceNativeHistoryCache.items {
		if key.path == path {
			delete(workspaceNativeHistoryCache.items, key)
		}
	}
}

func workspaceNativeHistoryCacheStore(key workspaceNativeHistoryCacheKey, modifiedAt int64, size int64, page map[string]any) {
	workspaceNativeHistoryCache.Lock()
	defer workspaceNativeHistoryCache.Unlock()
	if len(workspaceNativeHistoryCache.items) >= workspaceNativeHistoryCacheMaxEntries {
		var oldestKey workspaceNativeHistoryCacheKey
		var oldestAt time.Time
		for candidateKey, entry := range workspaceNativeHistoryCache.items {
			if oldestAt.IsZero() || entry.lastAccess.Before(oldestAt) {
				oldestKey, oldestAt = candidateKey, entry.lastAccess
			}
		}
		delete(workspaceNativeHistoryCache.items, oldestKey)
	}
	workspaceNativeHistoryCache.items[key] = workspaceNativeHistoryCacheEntry{
		modifiedAt: modifiedAt,
		size:       size,
		page:       workspaceCloneNativeHistoryPage(page),
		lastAccess: time.Now(),
	}
}

func workspaceCloneNativeHistoryPage(page map[string]any) map[string]any {
	clone := make(map[string]any, len(page))
	for key, value := range page {
		clone[key] = value
	}
	if messages, ok := page["messages"].([]readmodels.TranscriptEntry); ok {
		copiedMessages := make([]readmodels.TranscriptEntry, len(messages))
		for index, message := range messages {
			copiedMessages[index] = make(readmodels.TranscriptEntry, len(message))
			for key, value := range message {
				copiedMessages[index][key] = value
			}
		}
		clone["messages"] = copiedMessages
	}
	return clone
}

func workspaceLoadNativeChatHistoryAround(meta state.SessionMeta, targetCursor string, limit int) (map[string]any, error) {
	if limit <= 0 {
		limit = legacyDefaultRecentLimit
	}
	beforeLimit := limit / 2
	before := []readmodels.TranscriptEntry{}
	messages := []readmodels.TranscriptEntry{}
	targetFound := false
	hasOlder := false
	var olderCursor *string
	err := parser.StreamSearchableMessages(meta.Agent, meta.SessionID, meta.TranscriptPath, func(message parser.SearchableMessage) bool {
		entry := workspaceTranscriptEntryFromSearchable(message)
		if targetFound {
			if len(messages) >= limit {
				return false
			}
			messages = append(messages, entry)
			return len(messages) < limit
		}
		if workspaceSearchableMatchesCursor(message, targetCursor) {
			targetFound = true
			messages = append(append([]readmodels.TranscriptEntry(nil), before...), entry)
			return len(messages) < limit
		}
		if len(before) >= beforeLimit {
			hasOlder = true
			before = before[1:]
		}
		before = append(before, entry)
		return true
	})
	if err != nil {
		return nil, err
	}
	if !targetFound {
		return map[string]any{
			"messages":    []readmodels.TranscriptEntry{},
			"hasOlder":    false,
			"olderCursor": nil,
			"targetFound": false,
		}, nil
	}
	if hasOlder && len(messages) > 0 {
		cursor := workspaceTranscriptCursor(messages[0])
		olderCursor = &cursor
	}
	return map[string]any{
		"messages":    messages,
		"hasOlder":    hasOlder,
		"olderCursor": olderCursor,
		"targetFound": true,
	}, nil
}

func workspaceTranscriptEntryFromSearchable(message parser.SearchableMessage) readmodels.TranscriptEntry {
	entry := readmodels.TranscriptEntry{
		"_id":       workspaceSearchableCursor(message),
		"messageId": message.ID,
	}
	if message.CreatedAt != nil {
		entry["createdAt"] = float64(message.CreatedAt.UnixMilli())
	}
	text := strings.TrimSpace(message.Text)
	if message.Kind == transcript.KindCommandExecution {
		entry["kind"] = transcript.KindCommandExecution
		for _, key := range []string{"itemId", "command", "cwd", "status", "aggregatedOutput", "exitCode", "durationMs"} {
			if value, ok := message.Fields[key]; ok {
				entry[key] = value
			}
		}
		return entry
	}
	if message.Kind == transcript.KindTurnPlan {
		entry["kind"] = transcript.KindTurnPlan
		for _, key := range []string{"turnId", "explanation", "plan"} {
			if value, ok := message.Fields[key]; ok {
				entry[key] = value
			}
		}
		return entry
	}
	if message.Kind == transcript.KindProposedPlan {
		entry["kind"] = transcript.KindProposedPlan
		for _, key := range []string{"turnId", "plan"} {
			if value, ok := message.Fields[key]; ok {
				entry[key] = value
			}
		}
		return entry
	}
	if message.Kind == transcript.KindFileChange {
		entry["kind"] = transcript.KindFileChange
		for _, key := range []string{"itemId", "status", "changes", "outputDelta"} {
			if value, ok := message.Fields[key]; ok {
				entry[key] = value
			}
		}
		return entry
	}
	if message.Kind == transcript.KindResult {
		entry["kind"] = transcript.KindResult
		entry["subtype"] = firstNonEmpty(stringValue(message.Fields["subtype"]), "error")
		isError, _ := message.Fields["isError"].(bool)
		entry["isError"] = isError
		entry["durationMs"] = message.Fields["durationMs"]
		entry["result"] = text
		return entry
	}
	if message.Kind == transcript.KindModelChange {
		entry["kind"] = transcript.KindModelChange
		for _, key := range []string{"model", "reasoningEffort"} {
			if value, ok := message.Fields[key]; ok && strings.TrimSpace(stringValue(value)) != "" {
				entry[key] = value
			}
		}
		return entry
	}
	if message.Kind == "mcp_tool_call" {
		toolID := firstNonEmpty(stringValue(message.Fields["toolId"]), workspaceSearchableCursor(message))
		server := stringValue(message.Fields["server"])
		tool := stringValue(message.Fields["tool"])
		if tool == "" {
			tool = message.Text
		}
		entry["kind"] = transcript.KindToolCall
		entry["tool"] = map[string]any{
			"kind":     "tool",
			"toolKind": "mcp_generic",
			"toolName": "mcp__" + server + "__" + tool,
			"toolId":   toolID,
			"input": map[string]any{
				"server":  server,
				"tool":    tool,
				"payload": message.Fields["input"],
			},
		}
		return entry
	}
	if message.Kind == "mcp_tool_result" {
		entry["kind"] = transcript.KindToolResult
		entry["toolId"] = message.Fields["toolId"]
		entry["content"] = message.Fields["content"]
		if isError, ok := message.Fields["isError"].(bool); ok {
			entry["isError"] = isError
		}
		return entry
	}
	switch workspaceSearchableTranscriptRole(message) {
	case "user":
		entry["kind"] = transcript.KindUserPrompt
		content, attachments := workspaceCodexUserPrompt(text)
		entry["content"] = content
		if len(attachments) > 0 {
			entry["attachments"] = attachments
		}
	case "assistant":
		entry["kind"] = transcript.KindAssistantText
		entry["text"] = text
	case "tool":
		entry["kind"] = transcript.KindToolCall
		entry["tool"] = map[string]any{
			"kind":     "tool",
			"toolKind": "native",
			"toolName": "native transcript",
			"toolId":   workspaceSearchableCursor(message),
			"input": map[string]any{
				"summary": text,
			},
		}
	default:
		entry["kind"] = transcript.KindStatus
		entry["status"] = text
	}
	return entry
}

func workspaceCodexUserPrompt(value string) (string, []readmodels.ChatAttachment) {
	const filesMarker = "# files mentioned by the user:"
	const requestMarker = "## my request for codex:"
	lines := strings.Split(value, "\n")
	attachments := []readmodels.ChatAttachment{}
	for index, line := range lines {
		if !strings.EqualFold(strings.TrimSpace(line), filesMarker) {
			continue
		}
		for _, attachmentLine := range lines[index+1:] {
			trimmed := strings.TrimSpace(attachmentLine)
			if !strings.HasPrefix(trimmed, "## ") {
				continue
			}
			if strings.EqualFold(trimmed, requestMarker) {
				break
			}
			parts := strings.SplitN(strings.TrimPrefix(trimmed, "## "), ": ", 2)
			if len(parts) != 2 || strings.TrimSpace(parts[0]) == "" || strings.TrimSpace(parts[1]) == "" {
				continue
			}
			path := strings.TrimSpace(parts[1])
			attachments = append(attachments, workspaceNativeAttachment(
				"native-attachment-"+strconv.Itoa(index)+"-"+strconv.Itoa(len(attachments)),
				strings.TrimSpace(parts[0]),
				path,
			))
		}
		break
	}
	lastRequest := -1
	for index, line := range lines {
		if strings.EqualFold(strings.TrimSpace(line), requestMarker) {
			lastRequest = index
		}
	}
	if lastRequest < 0 {
		if len(attachments) > 0 {
			return strings.TrimSpace(value), attachments
		}
		return workspaceLegacyInlineAttachmentPrompt(value)
	}
	return strings.TrimSpace(strings.Join(lines[lastRequest+1:], "\n")), attachments
}

func workspaceLegacyInlineAttachmentPrompt(value string) (string, []readmodels.ChatAttachment) {
	const prefix = "[Attached text file: "
	start := strings.Index(value, prefix)
	if start < 0 {
		return strings.TrimSpace(value), nil
	}
	nameStart := start + len(prefix)
	nameEnd := strings.Index(value[nameStart:], "]")
	if nameEnd < 0 {
		return strings.TrimSpace(value), nil
	}
	nameEnd += nameStart
	name := strings.TrimSpace(value[nameStart:nameEnd])
	bodyStart := nameEnd + 1
	if strings.HasPrefix(value[bodyStart:], "\r\n\r\n") {
		bodyStart += len("\r\n\r\n")
	} else if strings.HasPrefix(value[bodyStart:], "\n\n") {
		bodyStart += len("\n\n")
	}
	if name == "" || bodyStart > len(value) {
		return strings.TrimSpace(value), nil
	}
	body := value[bodyStart:]
	return strings.TrimSpace(value[:start]), []readmodels.ChatAttachment{{
		ID: "legacy-inline-attachment-0", Kind: "file", DisplayName: name,
		MimeType: workspaceAttachmentMimeType(name), Size: int64(len(body)),
	}}
}

func workspaceAttachmentMimeType(path string) string {
	return detectUploadMime(path, "")
}

func workspaceNativeAttachment(fallbackID string, displayName string, path string) readmodels.ChatAttachment {
	cleanPath := filepath.Clean(path)
	if uploaded, ok := workspaceUploadedAttachment(cleanPath); ok {
		return uploaded
	}
	mimeType := workspaceAttachmentMimeType(cleanPath)
	attachment := readmodels.ChatAttachment{
		ID:           fallbackID,
		Kind:         attachmentKind(mimeType),
		DisplayName:  displayName,
		AbsolutePath: cleanPath,
		RelativePath: cleanPath,
		MimeType:     mimeType,
	}
	if info, err := os.Stat(cleanPath); err == nil && info.Mode().IsRegular() {
		attachment.Size = info.Size()
	}
	return attachment
}

func workspaceUploadedAttachment(path string) (readmodels.ChatAttachment, bool) {
	projectID := filepath.Base(filepath.Dir(path))
	uploadID := filepath.Base(path)
	if projectID == "." || uploadID == "." || filepath.Clean(filepath.Join(uploadDir(projectID), uploadID)) != path {
		return readmodels.ChatAttachment{}, false
	}
	uploaded, err := loadUploadMetadata(projectID, uploadID)
	if err != nil || filepath.Clean(uploaded.AbsolutePath) != path {
		return readmodels.ChatAttachment{}, false
	}
	return readmodels.ChatAttachment{
		ID:           uploaded.ID,
		Kind:         uploaded.Kind,
		DisplayName:  uploaded.DisplayName,
		AbsolutePath: uploaded.AbsolutePath,
		RelativePath: uploaded.RelativePath,
		ContentURL:   uploaded.ContentURL,
		MimeType:     uploaded.MimeType,
		Size:         uploaded.Size,
	}, true
}

func workspaceSearchableCursor(message parser.SearchableMessage) string {
	if strings.TrimSpace(message.ID) != "" {
		return strings.TrimSpace(message.ID)
	}
	return strconv.Itoa(message.Index)
}

func workspaceSearchableMatchesCursor(message parser.SearchableMessage, cursor string) bool {
	cursor = strings.TrimSpace(cursor)
	if cursor == "" {
		return false
	}
	return cursor == workspaceSearchableCursor(message) || cursor == strconv.Itoa(message.Index)
}

func workspaceMaterializeImportedChatIfNeeded(chatID string) (string, error) {
	if workspaceStoredChatExists(chatID) {
		return chatID, nil
	}
	if _, ok := workspaceLegacySessionByChatID(chatID); !ok {
		return chatID, nil
	}
	return workspaceMaterializeLegacyChat(chatID)
}

func workspaceStoredChatExists(chatID string) bool {
	chatID = strings.TrimSpace(chatID)
	if chatID == "" {
		return false
	}
	state, err := workspaceStore().LoadStateLight()
	if err != nil {
		return false
	}
	chat, ok := state.ChatsByID[chatID]
	return ok && chat.DeletedAt == 0
}

func workspaceLoadLegacyChatHistory(meta state.SessionMeta, beforeCursor string, limit int) (map[string]any, error) {
	return map[string]any{
		"messages":    []readmodels.TranscriptEntry{},
		"hasOlder":    false,
		"olderCursor": nil,
	}, nil
}

func workspaceLoadLegacyChatHistoryAround(meta state.SessionMeta, targetCursor string, limit int) (map[string]any, error) {
	return map[string]any{
		"messages":    []readmodels.TranscriptEntry{},
		"hasOlder":    false,
		"olderCursor": nil,
		"targetFound": false,
	}, nil
}

func workspaceChatMessages(chatID string) ([]readmodels.TranscriptEntry, error) {
	chat, _, err := workspaceChatProjectRequired(chatID)
	if err != nil {
		return nil, err
	}
	if workspaceChatHasTmuxRuntime(chat) {
		return []readmodels.TranscriptEntry{}, nil
	}
	return workspaceStore().ReplayTranscriptEntriesForChat(chatID, 0)
}

func workspaceProjectRequired(projectID string) (readmodels.ProjectRecord, error) {
	projectID = strings.TrimSpace(projectID)
	if projectID == "" {
		return readmodels.ProjectRecord{}, errors.New("projectId is required")
	}
	state, err := workspaceStore().LoadStateLight()
	if err != nil {
		return readmodels.ProjectRecord{}, err
	}
	project, ok := state.ProjectsByID[projectID]
	if !ok || project.DeletedAt != 0 {
		return readmodels.ProjectRecord{}, errors.New("project not found")
	}
	return project, nil
}

func workspaceRuntimeProjectRequired(projectID string) (readmodels.ProjectRecord, error) {
	projectID = strings.TrimSpace(projectID)
	if projectID == "" {
		return readmodels.ProjectRecord{}, errors.New("projectId is required")
	}
	state, err := workspaceStore().LoadStateLight()
	if err != nil {
		return readmodels.ProjectRecord{}, err
	}
	if project, ok := state.ProjectsByID[projectID]; ok && project.DeletedAt == 0 {
		return project, nil
	}
	if project, ok := workspaceLegacyProjectByID(projectID); ok && strings.TrimSpace(project.LocalPath) != "" {
		return project, nil
	}
	return readmodels.ProjectRecord{}, errors.New("project not found")
}

func workspaceChatProjectRequired(chatID string) (readmodels.ChatRecord, readmodels.ProjectRecord, error) {
	chatID = strings.TrimSpace(chatID)
	if chatID == "" {
		return readmodels.ChatRecord{}, readmodels.ProjectRecord{}, errors.New("chatId is required")
	}
	state, err := workspaceStore().LoadStateLight()
	if err != nil {
		return readmodels.ChatRecord{}, readmodels.ProjectRecord{}, err
	}
	chat, ok := state.ChatsByID[chatID]
	if !ok || chat.DeletedAt != 0 {
		return readmodels.ChatRecord{}, readmodels.ProjectRecord{}, errors.New("chat not found")
	}
	project, ok := state.ProjectsByID[chat.ProjectID]
	if !ok || project.DeletedAt != 0 {
		return readmodels.ChatRecord{}, readmodels.ProjectRecord{}, errors.New("project not found")
	}
	return chat, project, nil
}

func workspaceAck() map[string]any {
	return map[string]any{"ok": true, "timestamp": time.Now().UnixMilli()}
}
