package server

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"abolqasem/internal/parser"
	"abolqasem/internal/sessioninterop"
	"abolqasem/internal/state"
	"abolqasem/internal/workspace/events"
	"abolqasem/internal/workspace/legacyimport"
	"abolqasem/internal/workspace/readmodels"
	"abolqasem/internal/workspace/transcript"
)

const legacyDefaultRecentLimit = 200

var workspaceLoadLegacyState = state.LoadState
var workspaceSaveLegacyState = state.SaveState

var workspaceLegacyImportedSessionCache = struct {
	sync.Mutex
	items map[string]cachedLegacyImportedSession
	bytes int
}{items: map[string]cachedLegacyImportedSession{}}

type cachedLegacyImportedSession struct {
	updatedAt      int64
	imported       legacyimport.ImportedSession
	lastAccess     time.Time
	estimatedBytes int
}

const (
	workspaceLegacyImportedCacheTTL      = 10 * time.Minute
	workspaceLegacyImportedCacheMaxItems = 8
	workspaceLegacyImportedCacheMaxBytes = 96 * 1024 * 1024
)

type workspaceLegacyImportedCacheStats struct {
	Entries        int `json:"entries"`
	EstimatedBytes int `json:"estimated_bytes"`
	MaxEntries     int `json:"max_entries"`
	MaxBytes       int `json:"max_bytes"`
}

func workspaceLegacyImportedSessionCacheStats() workspaceLegacyImportedCacheStats {
	workspaceLegacyImportedSessionCache.Lock()
	defer workspaceLegacyImportedSessionCache.Unlock()
	return workspaceLegacyImportedCacheStats{
		Entries:        len(workspaceLegacyImportedSessionCache.items),
		EstimatedBytes: workspaceLegacyImportedSessionCache.bytes,
		MaxEntries:     workspaceLegacyImportedCacheMaxItems,
		MaxBytes:       workspaceLegacyImportedCacheMaxBytes,
	}
}

func mergeLegacySidebarData(sidebar readmodels.SidebarData) readmodels.SidebarData {
	stateSnapshot, _ := workspaceStore().LoadStateLight()
	return mergeLegacySidebarDataWithStoreState(sidebar, stateSnapshot)
}

func mergeLegacySidebarDataWithStoreState(sidebar readmodels.SidebarData, stateSnapshot readmodels.StoreState) readmodels.SidebarData {
	appState, _ := workspaceLoadLegacyState()
	sessions := workspaceLegacySessionMetasFromAppState(appState)
	if len(sessions) == 0 {
		return sidebar
	}

	groupIndexByPath := map[string]int{}
	for index, group := range sidebar.ProjectGroups {
		if group.LocalPath != "" {
			groupIndexByPath[group.LocalPath] = index
		}
	}

	legacyMetaChanged := false
	for _, meta := range sessions {
		sidebarMeta := workspaceSidebarLegacySessionMeta(meta)
		if appState != nil && persistLegacySidebarMeta(appState, meta, sidebarMeta) {
			legacyMetaChanged = true
		}
		imported := legacyimport.ImportSession(sidebarMeta, nil, legacyimport.ImportOptions{})
		row := legacySidebarRow(imported, sidebarMeta, appState != nil && appState.UnreadSessionKeys[sidebarMeta.Key])
		if row.ChatID == "" {
			continue
		}
		if linkedChatID := workspaceStoredChatIDForLegacyMeta(stateSnapshot, sidebarMeta); linkedChatID != "" {
			_ = workspaceRenameLegacyChatIfGenerated(linkedChatID, sidebarMeta, row.Title)
			for groupIndex := range sidebar.ProjectGroups {
				overlayLegacySidebarChatTitle(&sidebar.ProjectGroups[groupIndex], linkedChatID, row.Title, sidebarMeta)
			}
			continue
		}
		groupIndex, ok := groupIndexByPath[imported.Project.LocalPath]
		if !ok {
			sidebar.ProjectGroups = append(sidebar.ProjectGroups, readmodels.SidebarProjectGroup{
				GroupKey:         imported.Project.ID,
				Title:            imported.Project.Title,
				RealTitle:        imported.Project.Title,
				LocalPath:        imported.Project.LocalPath,
				Chats:            []readmodels.SidebarChatRow{},
				PreviewChats:     []readmodels.SidebarChatRow{},
				OlderChats:       []readmodels.SidebarChatRow{},
				ArchivedChats:    []readmodels.SidebarChatRow{},
				DefaultCollapsed: false,
			})
			groupIndex = len(sidebar.ProjectGroups) - 1
			if imported.Project.LocalPath != "" {
				groupIndexByPath[imported.Project.LocalPath] = groupIndex
			}
		}
		if sidebarHasChat(sidebar.ProjectGroups[groupIndex], row.ChatID) {
			_ = workspaceRenameLegacyChatIfGenerated(row.ChatID, sidebarMeta, row.Title)
			overlayLegacySidebarChatTitle(&sidebar.ProjectGroups[groupIndex], row.ChatID, row.Title, sidebarMeta)
		} else {
			sidebar.ProjectGroups[groupIndex].Chats = append(sidebar.ProjectGroups[groupIndex].Chats, row)
		}
	}
	if legacyMetaChanged {
		_ = workspaceSaveLegacyState(appState)
	}

	for index := range sidebar.ProjectGroups {
		sort.SliceStable(sidebar.ProjectGroups[index].Chats, func(i, j int) bool {
			return sidebarChatTimestamp(sidebar.ProjectGroups[index].Chats[i]) > sidebarChatTimestamp(sidebar.ProjectGroups[index].Chats[j])
		})
		readmodels.PopulateSidebarBuckets(&sidebar.ProjectGroups[index], time.Now().UnixMilli())
	}
	sort.SliceStable(sidebar.ProjectGroups, func(i, j int) bool {
		return groupTimestamp(sidebar.ProjectGroups[i]) > groupTimestamp(sidebar.ProjectGroups[j])
	})
	return sidebar
}

func persistLegacySidebarMeta(appState *state.AppState, before state.SessionMeta, after state.SessionMeta) bool {
	if appState == nil || strings.TrimSpace(after.Key) == "" || before == after {
		return false
	}
	current, ok := appState.Sessions[after.Key]
	if !ok {
		return false
	}
	if current != before {
		return false
	}
	appState.Sessions[after.Key] = after
	return true
}

func workspaceLegacyChatSnapshot(chatID string, recentLimit int) any {
	meta, ok := workspaceLegacySessionByChatID(chatID)
	if !ok {
		return nil
	}
	meta = workspaceEnrichLegacySessionMeta(meta)
	imported := legacyimport.ImportSession(meta, nil, legacyimport.ImportOptions{})
	provider := strings.TrimSpace(meta.Agent)
	sessionToken := strings.TrimSpace(meta.SessionID)
	if provider == "" || provider == "unknown" {
		provider = "codex"
	}
	providerValue := provider
	sessionTokenValue := sessionToken
	return &readmodels.ChatSnapshot{
		Runtime: readmodels.ChatRuntime{
			ChatID:               imported.Chat.ID,
			ProjectID:            imported.Project.ID,
			LocalPath:            imported.Project.LocalPath,
			Title:                imported.Chat.Title,
			Status:               readmodels.StatusIdle,
			IsDraining:           false,
			Provider:             &providerValue,
			PlanMode:             false,
			SessionToken:         &sessionTokenValue,
			ReadOnly:             false,
			LegacySessionKey:     "",
			TmuxSession:          workspaceChatTmuxSession(imported.Chat.ID),
			NativeSessionID:      sessionToken,
			NativeTranscriptPath: strings.TrimSpace(meta.TranscriptPath),
			LastSummary:          firstNonEmpty(meta.LastPreview, meta.FirstPreview),
		},
		QueuedMessages:     []readmodels.QueuedChatMessage{},
		Messages:           []readmodels.TranscriptEntry{},
		History:            readmodels.ChatHistorySnapshot{RecentLimit: recentLimit},
		AvailableProviders: workspaceAvailableProviders(),
	}
}

func workspaceMaterializeLegacyChat(importedChatID string) (string, error) {
	meta, ok := workspaceLegacySessionByChatID(importedChatID)
	if !ok {
		return "", errors.New("chat not found")
	}
	if strings.TrimSpace(meta.Cwd) == "" {
		return "", errors.New("chat cannot be materialized because cwd is missing")
	}

	chatID := legacyimport.ImportedChatID(meta)
	store := workspaceStore()
	stateSnapshot, err := store.LoadStateLight()
	if err != nil {
		return "", err
	}
	if linkedChatID := workspaceStoredChatIDForLegacyMeta(stateSnapshot, meta); linkedChatID != "" {
		_ = workspaceSyncLegacyBackedChat(linkedChatID, meta)
		return linkedChatID, nil
	}
	if chat, ok := stateSnapshot.ChatsByID[chatID]; ok && chat.DeletedAt == 0 {
		_ = workspaceSyncLegacyBackedChat(chatID, meta)
		return chatID, nil
	}

	meta = workspaceEnrichLegacySessionMeta(meta)
	imported := legacyimport.ImportSession(meta, nil, legacyimport.ImportOptions{})

	project, err := workspaceOpenProject(imported.Project.LocalPath, imported.Project.Title)
	if err != nil {
		return "", err
	}

	createdAt := imported.Chat.CreatedAt
	if createdAt == 0 {
		createdAt = time.Now().UnixMilli()
	}
	tmuxSession := workspaceChatTmuxSession(chatID)
	lastSummary := firstNonEmpty(meta.LastPreview, meta.FirstPreview)
	if err := appendWorkspaceStoreEvent(store, events.StreamChats, events.TypeChatCreated, createdAt, map[string]any{
		"chatId":               chatID,
		"projectId":            project.ID,
		"title":                imported.Chat.Title,
		"tmuxSession":          tmuxSession,
		"nativeSessionId":      strings.TrimSpace(meta.SessionID),
		"nativeTranscriptPath": strings.TrimSpace(meta.TranscriptPath),
		"lastSummary":          lastSummary,
	}); err != nil {
		return "", err
	}

	if provider := strings.TrimSpace(meta.Agent); provider != "" && provider != "unknown" {
		if err := appendWorkspaceStoreEvent(store, events.StreamChats, events.TypeChatProviderSet, createdAt, map[string]any{
			"chatId":   chatID,
			"provider": provider,
		}); err != nil {
			return "", err
		}
	}

	sessionToken := strings.TrimSpace(meta.SessionID)
	if sessionToken != "" {
		if err := appendWorkspaceStoreEvent(store, events.StreamTurns, events.TypeSessionTokenSet, createdAt, map[string]any{
			"chatId":       chatID,
			"sessionToken": &sessionToken,
		}); err != nil {
			return "", err
		}
	}

	return chatID, nil
}

func workspaceLegacySessionMetas() []state.SessionMeta {
	appState, err := workspaceLoadLegacyState()
	if err != nil || appState == nil {
		return nil
	}
	return workspaceLegacySessionMetasFromAppState(appState)
}

func workspaceLegacySessionMetasFromAppState(appState *state.AppState) []state.SessionMeta {
	if appState == nil {
		return nil
	}
	sessions := make([]state.SessionMeta, 0, len(appState.Sessions))
	for _, meta := range appState.Sessions {
		if strings.TrimSpace(meta.Key) == "" {
			continue
		}
		if !workspaceShouldExposeLegacySession(meta) {
			continue
		}
		sessions = append(sessions, meta)
	}
	sort.SliceStable(sessions, func(i, j int) bool {
		return sessions[i].UpdatedAt.After(sessions[j].UpdatedAt)
	})
	return sessions
}

func workspaceSidebarLegacySessionMeta(meta state.SessionMeta) state.SessionMeta {
	if strings.TrimSpace(meta.SessionName) != "" && !isGeneratedLegacySessionTitle(meta.SessionName, meta) {
		return meta
	}
	meta = workspaceEnrichLegacySessionMeta(meta)
	meta.SessionName = state.ResolveSessionName(meta)
	return meta
}

func workspaceEnrichLegacySessionMeta(meta state.SessionMeta) state.SessionMeta {
	if isGeneratedLegacySessionTitle(meta.SessionName, meta) {
		meta.SessionName = ""
	}
	if meta.FirstPreview != "" && meta.LastPreview != "" && meta.MessageCountEstimate > 0 {
		return meta
	}
	if strings.TrimSpace(meta.TranscriptPath) == "" {
		meta.SessionName = state.ResolveSessionName(meta)
		return meta
	}
	if summary, err := parser.GetSessionSummary(meta.Agent, meta.SessionID, meta.TranscriptPath); err == nil {
		meta.FirstPreview = firstNonEmpty(meta.FirstPreview, summary.FirstPreview)
		meta.LastPreview = firstNonEmpty(meta.LastPreview, summary.LastPreview)
		meta.MessageCountEstimate = summary.MessageCountEstimate
		meta.MetadataOnly = false
		meta.InvalidReason = ""
		meta.SessionName = state.ResolveSessionName(meta)
		return meta
	} else if errors.Is(err, parser.ErrTranscriptUnavailable) {
		meta.MetadataOnly = true
		if meta.InvalidReason == "" {
			meta.InvalidReason = "transcript is not readable"
		}
		meta.SessionName = state.ResolveSessionName(meta)
		return meta
	}
	if imported, err := workspaceImportedLegacySession(meta); err == nil {
		meta = workspaceLegacySessionMetaFromImported(meta, imported)
		meta.MetadataOnly = false
		meta.InvalidReason = ""
		meta.SessionName = state.ResolveSessionName(meta)
		return meta
	}
	meta.MetadataOnly = true
	if meta.InvalidReason == "" {
		meta.InvalidReason = "transcript could not be imported"
	}
	meta.SessionName = state.ResolveSessionName(meta)
	return meta
}

func workspaceLegacySessionMetaFromImported(meta state.SessionMeta, imported legacyimport.ImportedSession) state.SessionMeta {
	if title := strings.TrimSpace(imported.Chat.Title); title != "" && !isGeneratedLegacySessionTitle(title, meta) {
		meta.SessionName = title
	}
	meta.MessageCountEstimate = len(imported.Transcript.Messages)
	firstAnyPreview := ""
	firstUserPreview := ""
	lastPreview := ""
	for _, entry := range imported.Transcript.Messages {
		text, isUser := workspaceTranscriptEntryPreview(entry)
		if strings.TrimSpace(text) == "" {
			continue
		}
		isBootstrap := state.IsAgentBootstrapPrompt(text)
		if firstAnyPreview == "" && !isBootstrap {
			firstAnyPreview = text
		}
		if firstUserPreview == "" && isUser && !isBootstrap {
			firstUserPreview = text
		}
		lastPreview = text
	}
	if meta.FirstPreview == "" {
		meta.FirstPreview = firstNonEmpty(firstUserPreview, firstAnyPreview)
	}
	if meta.LastPreview == "" {
		meta.LastPreview = lastPreview
	}
	return meta
}

func workspaceTranscriptEntryPreview(entry readmodels.TranscriptEntry) (string, bool) {
	switch transcript.Kind(entry) {
	case transcript.KindUserPrompt:
		return strings.TrimSpace(workspaceFlattenPreviewValue(entry["content"])), true
	case transcript.KindAssistantText:
		return strings.TrimSpace(workspaceFlattenPreviewValue(entry["text"])), false
	case transcript.KindCompactSummary:
		return strings.TrimSpace(workspaceFlattenPreviewValue(entry["summary"])), false
	case transcript.KindStatus:
		return strings.TrimSpace(workspaceFlattenPreviewValue(entry["status"])), false
	case transcript.KindToolResult:
		return strings.TrimSpace(workspaceFlattenPreviewValue(entry["content"])), false
	default:
		return "", false
	}
}

func workspaceFlattenPreviewValue(value any) string {
	switch typed := value.(type) {
	case nil:
		return ""
	case string:
		return typed
	case []any:
		parts := make([]string, 0, len(typed))
		for _, item := range typed {
			text := strings.TrimSpace(workspaceFlattenPreviewValue(item))
			if text != "" {
				parts = append(parts, text)
			}
		}
		return strings.Join(parts, "\n\n")
	case map[string]any:
		for _, key := range []string{"text", "content", "message", "output", "result"} {
			if text := strings.TrimSpace(workspaceFlattenPreviewValue(typed[key])); text != "" {
				return text
			}
		}
		body, _ := json.Marshal(typed)
		return string(body)
	default:
		body, _ := json.Marshal(typed)
		return string(body)
	}
}

func workspaceShouldExposeLegacySession(meta state.SessionMeta) bool {
	cwd := strings.TrimSpace(meta.Cwd)
	if cwd == "" {
		return false
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return true
	}
	providerRoots := []string{
		filepath.Join(home, ".claude", "projects"),
		filepath.Join(home, ".codex", "sessions"),
	}
	for _, root := range providerRoots {
		if strings.HasPrefix(filepath.Clean(cwd), filepath.Clean(root)+string(filepath.Separator)) || filepath.Clean(cwd) == filepath.Clean(root) {
			return false
		}
	}
	return true
}

func overlayLegacySidebarChatTitle(group *readmodels.SidebarProjectGroup, chatID string, title string, meta state.SessionMeta) {
	if group == nil || strings.TrimSpace(chatID) == "" || strings.TrimSpace(title) == "" {
		return
	}
	for index := range group.Chats {
		if group.Chats[index].ChatID == chatID && shouldReplaceLegacyChatTitle(group.Chats[index].Title, meta, title) {
			group.Chats[index].Title = title
		}
	}
	for index := range group.ArchivedChats {
		if group.ArchivedChats[index].ChatID == chatID && shouldReplaceLegacyChatTitle(group.ArchivedChats[index].Title, meta, title) {
			group.ArchivedChats[index].Title = title
		}
	}
}

func shouldReplaceLegacyChatTitle(current string, meta state.SessionMeta, next string) bool {
	current = strings.TrimSpace(current)
	next = strings.TrimSpace(next)
	if next == "" || current == next {
		return false
	}
	return current == "" ||
		current == "New Chat" ||
		current == "نشست بدون نام" ||
		state.IsAgentBootstrapPrompt(current) ||
		isGeneratedLegacySessionTitle(current, meta)
}

func isPromptSubmitHookEvent(event state.HookEvent) bool {
	name := strings.ToLower(strings.TrimSpace(event.HookEventName))
	if name == "userpromptsubmit" || name == "promptsubmitted" || name == "user_prompt_submit" {
		return true
	}
	return strings.TrimSpace(event.PromptPreview) != ""
}

func workspaceRecordHookPromptCheckpoint(meta state.SessionMeta, event state.HookEvent) (workspaceCheckpointRecord, error) {
	if !isPromptSubmitHookEvent(event) {
		return workspaceCheckpointRecord{}, nil
	}
	meta = workspaceEnrichLegacySessionMeta(meta)
	chatID := legacyimport.ImportedChatID(meta)
	materializedChatID, err := workspaceMaterializeLegacyChat(chatID)
	if err != nil {
		return workspaceCheckpointRecord{}, err
	}
	_ = workspaceSyncMaterializedLegacyChat(meta)
	promptPreview := firstNonEmpty(event.PromptPreview, meta.FirstPreview, meta.LastPreview)
	if workspaceHasRecentPromptCheckpoint(materializedChatID, promptPreview, 10*time.Second) {
		return workspaceCheckpointRecord{}, nil
	}
	record, err := workspaceCreateCheckpoint(workspaceCreateCheckpointArgs{
		ChatID:        materializedChatID,
		Trigger:       workspaceCheckpointTriggerPrompt,
		PromptPreview: promptPreview,
	})
	if err != nil {
		return workspaceCheckpointRecord{}, err
	}
	return record, nil
}

func workspaceHasRecentPromptCheckpoint(chatID string, promptPreview string, window time.Duration) bool {
	chat, project, err := workspaceChatProjectRequired(chatID)
	if err != nil {
		return false
	}
	now := time.Now().UnixMilli()
	trimmedPrompt := trimPromptPreview(promptPreview)
	for _, checkpoint := range workspaceListCheckpointsForProject(project.ID) {
		if checkpoint.ChatID != chat.ID || checkpoint.Trigger != workspaceCheckpointTriggerPrompt {
			continue
		}
		if now-checkpoint.CreatedAt > window.Milliseconds() {
			continue
		}
		if trimmedPrompt == "" || trimPromptPreview(checkpoint.PromptPreview) == trimmedPrompt {
			return true
		}
	}
	return false
}

func workspaceSyncMaterializedLegacyChat(meta state.SessionMeta) error {
	if linkedChatID, err := workspaceStoredChatIDForLegacySession(meta); err == nil && linkedChatID != "" {
		return workspaceSyncLegacyBackedChat(linkedChatID, meta)
	}
	return workspaceSyncLegacyBackedChat(legacyimport.ImportedChatID(meta), meta)
}

func workspaceLegacyBroadcastChatID(meta state.SessionMeta) string {
	if linkedChatID, err := workspaceStoredChatIDForLegacySession(meta); err == nil && linkedChatID != "" {
		return linkedChatID
	}
	return legacyimport.ImportedChatID(meta)
}

func workspaceLegacySessionNeedsSync(chat readmodels.ChatRecord, meta state.SessionMeta) bool {
	metaUpdatedAt := meta.UpdatedAt.UnixMilli()
	if metaUpdatedAt <= 0 {
		return false
	}
	return metaUpdatedAt > chat.UpdatedAt
}

func workspaceSyncLegacyBackedChat(chatID string, meta state.SessionMeta) error {
	meta = workspaceEnrichLegacySessionMeta(meta)
	chatID = strings.TrimSpace(chatID)
	if chatID == "" {
		return nil
	}
	store := workspaceStore()
	stateSnapshot, err := store.LoadStateLight()
	if err != nil {
		return err
	}
	chat, ok := stateSnapshot.ChatsByID[chatID]
	if !ok || chat.DeletedAt != 0 {
		return nil
	}
	imported := legacyimport.ImportSession(meta, nil, legacyimport.ImportOptions{})
	if provider := strings.TrimSpace(meta.Agent); provider != "" && provider != "unknown" && strings.TrimSpace(derefWorkspaceString(chat.Provider)) == "" {
		if err := appendWorkspaceStoreEvent(store, events.StreamChats, events.TypeChatProviderSet, time.Now().UnixMilli(), map[string]any{
			"chatId":   chatID,
			"provider": provider,
		}); err != nil {
			return err
		}
		chat.Provider = &provider
	}
	if sessionToken := strings.TrimSpace(meta.SessionID); sessionToken != "" && strings.TrimSpace(derefWorkspaceString(chat.SessionToken)) == "" {
		if err := (&workspaceEventStore{store: store}).SetSessionToken(chatID, sessionToken); err != nil {
			return err
		}
		chat.SessionToken = &sessionToken
	}
	if err := workspaceRenameLegacyChatIfGenerated(chatID, meta, imported.Chat.Title); err != nil {
		return err
	}
	syncTimestamp := workspaceMaxInt64(time.Now().UnixMilli(), imported.Chat.UpdatedAt, meta.UpdatedAt.UnixMilli())
	if err := appendWorkspaceStoreEvent(store, events.StreamChats, events.TypeChatRuntimeSet, syncTimestamp, map[string]any{
		"chatId":               chatID,
		"tmuxSession":          firstNonEmpty(chat.TmuxSession, workspaceChatTmuxSession(chatID)),
		"nativeSessionId":      strings.TrimSpace(meta.SessionID),
		"nativeTranscriptPath": strings.TrimSpace(meta.TranscriptPath),
		"lastSummary":          firstNonEmpty(meta.LastPreview, meta.FirstPreview, chat.LastSummary),
	}); err != nil {
		return err
	}
	if err := appendWorkspaceStoreEvent(store, events.StreamChats, events.TypeChatReadStateSet, syncTimestamp, map[string]any{
		"chatId": chatID,
		"unread": true,
	}); err != nil {
		return err
	}
	return workspaceMarkLegacyChatSynced(store, chatID, meta)
}

type workspaceLegacySyncMarkerStore interface {
	LoadStateLight() (readmodels.StoreState, error)
	Append(string, events.Event) error
}

func workspaceMarkLegacyChatSynced(store workspaceLegacySyncMarkerStore, chatID string, meta state.SessionMeta) error {
	metaUpdatedAt := meta.UpdatedAt.UnixMilli()
	if metaUpdatedAt <= 0 {
		return nil
	}
	stateSnapshot, err := store.LoadStateLight()
	if err != nil {
		return err
	}
	chat, ok := stateSnapshot.ChatsByID[chatID]
	if !ok || chat.DeletedAt != 0 || chat.UpdatedAt >= metaUpdatedAt {
		return nil
	}
	return appendWorkspaceStoreEvent(store, events.StreamChats, events.TypeChatRenamed, metaUpdatedAt, map[string]any{
		"chatId": chatID,
		"title":  chat.Title,
	})
}

func workspaceImportedLegacySession(meta state.SessionMeta) (legacyimport.ImportedSession, error) {
	cacheKey := workspaceLegacyImportedSessionCacheKey(meta)
	cacheUpdatedAt := meta.UpdatedAt.UnixMilli()
	if cacheKey != "" && cacheUpdatedAt > 0 {
		if cached, ok := getWorkspaceLegacyImportedSessionCache(cacheKey, cacheUpdatedAt); ok {
			return cached.imported, nil
		}
	}

	imported := legacyimport.ImportSession(meta, nil, legacyimport.ImportOptions{})
	result, err := sessioninterop.ImportLegacySession(meta)
	if err != nil {
		return imported, err
	}

	imported.Transcript.Messages = workspaceLegacyImportedMessages(meta, result.Entries)
	if title := strings.TrimSpace(result.SessionName); title != "" {
		imported.Chat.Title = title
	}
	if projectTitle := strings.TrimSpace(result.ProjectName); projectTitle != "" {
		imported.Project.Title = projectTitle
	}
	if provider := strings.TrimSpace(result.Provider); provider != "" && provider != "unknown" {
		imported.Chat.Provider = &provider
	}
	if sessionToken := strings.TrimSpace(result.SessionToken); sessionToken != "" {
		imported.Chat.SessionToken = &sessionToken
	}
	imported.Chat.HasMessages = len(imported.Transcript.Messages) > 0

	createdAt := workspaceFirstTranscriptEntryTimestamp(imported.Transcript.Messages)
	updatedAt := workspaceLastTranscriptEntryTimestamp(imported.Transcript.Messages)
	if createdAt > 0 {
		imported.Project.CreatedAt = createdAt
		imported.Chat.CreatedAt = createdAt
	}
	if updatedAt > 0 {
		imported.Project.UpdatedAt = updatedAt
		imported.Chat.UpdatedAt = updatedAt
	}
	if updatedAt > 0 {
		imported.Chat.LastMessageAt = updatedAt
	}
	if cacheKey != "" && cacheUpdatedAt > 0 {
		setWorkspaceLegacyImportedSessionCache(cacheKey, cacheUpdatedAt, imported)
	}
	return imported, nil
}

func getWorkspaceLegacyImportedSessionCache(cacheKey string, updatedAt int64) (cachedLegacyImportedSession, bool) {
	workspaceLegacyImportedSessionCache.Lock()
	defer workspaceLegacyImportedSessionCache.Unlock()

	cached, ok := workspaceLegacyImportedSessionCache.items[cacheKey]
	if !ok || cached.updatedAt != updatedAt {
		if ok {
			removeWorkspaceLegacyImportedSessionCacheLocked(cacheKey)
		}
		return cachedLegacyImportedSession{}, false
	}
	now := time.Now()
	if now.Sub(cached.lastAccess) > workspaceLegacyImportedCacheTTL {
		removeWorkspaceLegacyImportedSessionCacheLocked(cacheKey)
		return cachedLegacyImportedSession{}, false
	}
	cached.lastAccess = now
	workspaceLegacyImportedSessionCache.items[cacheKey] = cached
	return cached, true
}

func setWorkspaceLegacyImportedSessionCache(cacheKey string, updatedAt int64, imported legacyimport.ImportedSession) {
	estimatedBytes := estimateWorkspaceImportedSessionBytes(imported)
	if estimatedBytes > workspaceLegacyImportedCacheMaxBytes/2 {
		return
	}

	workspaceLegacyImportedSessionCache.Lock()
	defer workspaceLegacyImportedSessionCache.Unlock()

	if _, ok := workspaceLegacyImportedSessionCache.items[cacheKey]; ok {
		removeWorkspaceLegacyImportedSessionCacheLocked(cacheKey)
	}
	workspaceLegacyImportedSessionCache.items[cacheKey] = cachedLegacyImportedSession{
		updatedAt:      updatedAt,
		imported:       imported,
		lastAccess:     time.Now(),
		estimatedBytes: estimatedBytes,
	}
	workspaceLegacyImportedSessionCache.bytes += estimatedBytes
	evictWorkspaceLegacyImportedSessionCacheLocked(time.Now())
}

func removeWorkspaceLegacyImportedSessionCacheLocked(cacheKey string) {
	cached, ok := workspaceLegacyImportedSessionCache.items[cacheKey]
	if !ok {
		return
	}
	workspaceLegacyImportedSessionCache.bytes -= cached.estimatedBytes
	if workspaceLegacyImportedSessionCache.bytes < 0 {
		workspaceLegacyImportedSessionCache.bytes = 0
	}
	delete(workspaceLegacyImportedSessionCache.items, cacheKey)
}

func evictWorkspaceLegacyImportedSessionCacheLocked(now time.Time) {
	for key, cached := range workspaceLegacyImportedSessionCache.items {
		if now.Sub(cached.lastAccess) > workspaceLegacyImportedCacheTTL {
			removeWorkspaceLegacyImportedSessionCacheLocked(key)
		}
	}
	for len(workspaceLegacyImportedSessionCache.items) > workspaceLegacyImportedCacheMaxItems ||
		workspaceLegacyImportedSessionCache.bytes > workspaceLegacyImportedCacheMaxBytes {
		oldestKey := ""
		var oldest time.Time
		for key, cached := range workspaceLegacyImportedSessionCache.items {
			if oldestKey == "" || cached.lastAccess.Before(oldest) {
				oldestKey = key
				oldest = cached.lastAccess
			}
		}
		if oldestKey == "" {
			return
		}
		removeWorkspaceLegacyImportedSessionCacheLocked(oldestKey)
	}
}

func estimateWorkspaceImportedSessionBytes(imported legacyimport.ImportedSession) int {
	total := 4096 + len(imported.Transcript.Messages)*512
	total += len(imported.Project.ID) + len(imported.Project.LocalPath) + len(imported.Project.Title)
	total += len(imported.Chat.ID) + len(imported.Chat.Title) + len(imported.LegacySessionKey) + len(imported.TranscriptPath)
	for _, entry := range imported.Transcript.Messages {
		total += estimateWorkspaceValueBytes(entry, 0)
	}
	return total
}

func estimateWorkspaceValueBytes(value any, depth int) int {
	if depth > 4 {
		return 64
	}
	switch typed := value.(type) {
	case nil:
		return 0
	case string:
		return len(typed)
	case []byte:
		return len(typed)
	case []any:
		total := 64 + len(typed)*16
		for _, item := range typed {
			total += estimateWorkspaceValueBytes(item, depth+1)
		}
		return total
	case map[string]any:
		total := 128 + len(typed)*64
		for key, item := range typed {
			total += len(key) + estimateWorkspaceValueBytes(item, depth+1)
		}
		return total
	case readmodels.TranscriptEntry:
		total := 128 + len(typed)*64
		for key, item := range typed {
			total += len(key) + estimateWorkspaceValueBytes(item, depth+1)
		}
		return total
	default:
		return 64
	}
}

func workspaceLegacyImportedSessionCacheKey(meta state.SessionMeta) string {
	parts := []string{
		strings.TrimSpace(meta.Key),
		strings.TrimSpace(meta.Agent),
		strings.TrimSpace(meta.SessionID),
		strings.TrimSpace(meta.TranscriptPath),
		strings.TrimSpace(meta.Cwd),
	}
	return strings.Join(parts, "|")
}

func workspaceLegacyImportedMessages(meta state.SessionMeta, entries []readmodels.TranscriptEntry) []readmodels.TranscriptEntry {
	if len(entries) == 0 {
		return []readmodels.TranscriptEntry{}
	}
	out := make([]readmodels.TranscriptEntry, 0, len(entries))
	for _, entry := range entries {
		cloned := make(readmodels.TranscriptEntry, len(entry)+3)
		for key, value := range entry {
			cloned[key] = value
		}
		cloned["legacyImported"] = true
		cloned["legacySourceAgent"] = strings.TrimSpace(meta.Agent)
		cloned["legacySourceSessionID"] = strings.TrimSpace(meta.SessionID)
		out = append(out, cloned)
	}
	return out
}

func workspaceRecentTranscriptEntries(entries []readmodels.TranscriptEntry, recentLimit int) ([]readmodels.TranscriptEntry, readmodels.ChatHistorySnapshot) {
	history := readmodels.ChatHistorySnapshot{RecentLimit: recentLimit}
	if recentLimit <= 0 || len(entries) <= recentLimit {
		return append([]readmodels.TranscriptEntry{}, entries...), history
	}
	cursor := strconv.Itoa(len(entries) - recentLimit + 1)
	history.HasOlder = true
	history.OlderCursor = &cursor
	return append([]readmodels.TranscriptEntry(nil), entries[len(entries)-recentLimit:]...), history
}

func workspaceSliceTranscriptEntriesAround(entries []readmodels.TranscriptEntry, targetCursor string, limit int) ([]readmodels.TranscriptEntry, bool, *string, bool) {
	if limit <= 0 {
		limit = legacyDefaultRecentLimit
	}
	targetIndex := workspaceTranscriptEntryIndex(entries, targetCursor)
	if targetIndex < 0 {
		return []readmodels.TranscriptEntry{}, false, nil, false
	}

	before := limit / 2
	start := targetIndex - before
	if start < 0 {
		start = 0
	}
	end := start + limit
	if end > len(entries) {
		end = len(entries)
		start = end - limit
		if start < 0 {
			start = 0
		}
	}

	sliced := append([]readmodels.TranscriptEntry(nil), entries[start:end]...)
	if start == 0 || len(sliced) == 0 {
		return sliced, false, nil, true
	}
	// The cursor is exclusive. Point at the first returned entry so the next
	// page includes the entry immediately before this slice.
	cursor := workspaceTranscriptCursor(entries[start])
	if strings.TrimSpace(cursor) == "" {
		cursor = strconv.Itoa(start + 1)
	}
	return sliced, true, &cursor, true
}

func workspaceTranscriptEntryIndex(entries []readmodels.TranscriptEntry, cursor string) int {
	cursor = strings.TrimSpace(cursor)
	if cursor == "" {
		return -1
	}
	if numeric, err := strconv.Atoi(cursor); err == nil {
		if numeric >= 1 && numeric <= len(entries) {
			return numeric - 1
		}
	}
	for index, entry := range entries {
		if workspaceTranscriptCursor(entry) == cursor {
			return index
		}
	}
	return -1
}

func workspaceIsLegacyImportedEntry(meta state.SessionMeta, entry readmodels.TranscriptEntry) bool {
	if imported, ok := entry["legacyImported"].(bool); ok && imported {
		sessionID := workspaceEntryString(entry, "legacySourceSessionID")
		if sessionID == "" || strings.EqualFold(sessionID, strings.TrimSpace(meta.SessionID)) {
			return true
		}
	}
	messageID := workspaceEntryString(entry, "messageId")
	if strings.HasPrefix(messageID, "evt_"+strings.TrimSpace(meta.SessionID)+"_") {
		return true
	}
	entryID := workspaceEntryString(entry, "_id")
	for _, prefix := range workspaceLegacyImportedEntryPrefixes(meta) {
		if strings.HasPrefix(entryID, prefix) {
			return true
		}
	}
	return false
}

func workspaceLegacyImportedEntryPrefixes(meta state.SessionMeta) []string {
	sessionID := strings.TrimSpace(meta.SessionID)
	if sessionID == "" {
		return nil
	}
	switch strings.ToLower(strings.TrimSpace(meta.Agent)) {
	case "claude":
		return []string{
			"claude-user-" + sessionID + "-",
			"claude-assistant-" + sessionID + "-",
			"claude-tool-call-" + sessionID + "-",
			"claude-tool-result-" + sessionID + "-",
		}
	case "codex":
		return []string{
			"codex-user-" + sessionID + "-",
			"codex-assistant-" + sessionID + "-",
			"codex-tool-call-" + sessionID + "-",
			"codex-tool-result-" + sessionID + "-",
			"codex-message-" + sessionID + "-",
			"codex-compact-" + sessionID + "-",
		}
	case "opencode":
		return []string{
			"opencode-user-" + sessionID + "-",
			"opencode-assistant-" + sessionID + "-",
		}
	default:
		return nil
	}
}

func workspaceLegacyTranscriptUnavailable(err error) bool {
	return errors.Is(err, fs.ErrNotExist)
}

func workspaceFirstTranscriptEntryTimestamp(entries []readmodels.TranscriptEntry) int64 {
	for _, entry := range entries {
		if timestamp := transcriptEntryTimestamp(entry); timestamp > 0 {
			return timestamp
		}
	}
	return 0
}

func workspaceLastTranscriptEntryTimestamp(entries []readmodels.TranscriptEntry) int64 {
	for index := len(entries) - 1; index >= 0; index-- {
		if timestamp := transcriptEntryTimestamp(entries[index]); timestamp > 0 {
			return timestamp
		}
	}
	return 0
}

func workspaceRenameLegacyChatIfGenerated(chatID string, meta state.SessionMeta, nextTitle string) error {
	nextTitle = strings.TrimSpace(nextTitle)
	if nextTitle == "" {
		return nil
	}
	stateSnapshot, err := workspaceStore().LoadStateLight()
	if err != nil {
		return err
	}
	chat, ok := stateSnapshot.ChatsByID[chatID]
	if !ok || chat.DeletedAt != 0 || !shouldReplaceLegacyChatTitle(chat.Title, meta, nextTitle) {
		return nil
	}
	return appendWorkspaceStoreEvent(workspaceStore(), events.StreamChats, events.TypeChatRenamed, time.Now().UnixMilli(), map[string]any{
		"chatId": chatID,
		"title":  nextTitle,
	})
}

func transcriptEntryTimestamp(entry readmodels.TranscriptEntry) int64 {
	switch value := entry["createdAt"].(type) {
	case int64:
		return value
	case int:
		return int64(value)
	case float64:
		return int64(value)
	case json.Number:
		timestamp, _ := value.Int64()
		return timestamp
	default:
		return 0
	}
}

func isGeneratedLegacySessionTitle(title string, meta state.SessionMeta) bool {
	title = strings.TrimSpace(title)
	if title == "" {
		return false
	}
	if strings.EqualFold(title, strings.TrimSpace(meta.SessionID)) {
		return true
	}
	transcriptPath := strings.TrimSpace(meta.TranscriptPath)
	transcriptBase := strings.TrimSuffix(filepath.Base(transcriptPath), filepath.Ext(transcriptPath))
	if transcriptBase != "" && strings.EqualFold(title, transcriptBase) {
		return true
	}
	return looksLikeGeneratedSessionID(title)
}

func looksLikeGeneratedSessionID(value string) bool {
	value = strings.TrimSpace(strings.ToLower(value))
	if value == "" {
		return false
	}
	if strings.HasPrefix(value, "rollout-") {
		return true
	}
	if strings.Count(value, "-") < 3 {
		return false
	}
	hexLike := 0
	for _, r := range value {
		if r == '-' {
			continue
		}
		if (r >= '0' && r <= '9') || (r >= 'a' && r <= 'f') {
			hexLike++
			continue
		}
		return false
	}
	return hexLike >= 16
}

func workspaceLegacySessionByProviderToken(provider string, sessionToken string) (state.SessionMeta, bool) {
	provider = strings.TrimSpace(provider)
	sessionToken = strings.TrimSpace(sessionToken)
	if provider == "" || sessionToken == "" {
		return state.SessionMeta{}, false
	}
	for _, meta := range workspaceLegacySessionMetas() {
		if strings.EqualFold(strings.TrimSpace(meta.Agent), provider) && strings.EqualFold(strings.TrimSpace(meta.SessionID), sessionToken) {
			return meta, true
		}
	}
	return state.SessionMeta{}, false
}

func workspaceStoredChatIDForLegacySession(meta state.SessionMeta) (string, error) {
	stateSnapshot, err := workspaceStore().LoadStateLight()
	if err != nil {
		return "", err
	}
	return workspaceStoredChatIDForLegacyMeta(stateSnapshot, meta), nil
}

func workspaceStoredChatIDForLegacyMeta(stateSnapshot readmodels.StoreState, meta state.SessionMeta) string {
	importedChatID := legacyimport.ImportedChatID(meta)
	if chat, ok := stateSnapshot.ChatsByID[importedChatID]; ok && chat.DeletedAt == 0 {
		return importedChatID
	}
	sessionToken := strings.TrimSpace(meta.SessionID)
	provider := strings.TrimSpace(meta.Agent)
	if sessionToken == "" || provider == "" {
		return ""
	}
	var pendingForkChatID string
	for chatID, chat := range stateSnapshot.ChatsByID {
		if chat.DeletedAt != 0 {
			continue
		}
		if !strings.EqualFold(strings.TrimSpace(derefWorkspaceString(chat.Provider)), provider) {
			continue
		}
		if strings.EqualFold(strings.TrimSpace(chat.NativeSessionID), sessionToken) {
			return chatID
		}
		if !strings.EqualFold(strings.TrimSpace(derefWorkspaceString(chat.SessionToken)), sessionToken) {
			if pendingForkChatID == "" && strings.EqualFold(strings.TrimSpace(derefWorkspaceString(chat.PendingForkSessionToken)), sessionToken) {
				pendingForkChatID = chatID
			}
			continue
		}
		return chatID
	}
	if pendingForkChatID != "" {
		return pendingForkChatID
	}
	return ""
}

func workspaceLegacySessionByChatID(chatID string) (state.SessionMeta, bool) {
	chatID = strings.TrimSpace(chatID)
	if chatID == "" {
		return state.SessionMeta{}, false
	}
	for _, meta := range workspaceLegacySessionMetas() {
		if legacyimport.ImportedChatID(meta) == chatID || legacyimport.LegacyChatAliasID(meta) == chatID {
			return meta, true
		}
	}
	return state.SessionMeta{}, false
}

func workspaceLegacySessionForStoredChat(chat readmodels.ChatRecord, messages []readmodels.TranscriptEntry) (state.SessionMeta, bool) {
	sessionToken := strings.TrimSpace(derefWorkspaceString(chat.SessionToken))
	provider := strings.TrimSpace(derefWorkspaceString(chat.Provider))
	for _, meta := range workspaceLegacySessionMetas() {
		if sessionToken != "" && provider != "" {
			if strings.EqualFold(strings.TrimSpace(meta.SessionID), sessionToken) && strings.EqualFold(strings.TrimSpace(meta.Agent), provider) {
				if workspaceStoredChatLooksLegacyBacked(meta, messages) {
					return meta, true
				}
			}
		}
		if workspaceStoredChatLooksLegacyBacked(meta, messages) {
			if sessionToken == "" || strings.EqualFold(strings.TrimSpace(meta.SessionID), sessionToken) {
				return meta, true
			}
		}
	}
	return state.SessionMeta{}, false
}

func workspaceStoredChatLooksLegacyBacked(meta state.SessionMeta, messages []readmodels.TranscriptEntry) bool {
	if len(messages) == 0 {
		return false
	}
	for _, entry := range messages {
		if workspaceIsLegacyImportedEntry(meta, entry) {
			return true
		}
	}
	return false
}

func workspaceLegacyProjectByID(projectID string) (readmodels.ProjectRecord, bool) {
	projectID = strings.TrimSpace(projectID)
	if projectID == "" {
		return readmodels.ProjectRecord{}, false
	}
	for _, meta := range workspaceLegacySessionMetas() {
		imported := legacyimport.ImportSession(meta, nil, legacyimport.ImportOptions{})
		if imported.Project.ID == projectID || legacyimport.LegacyProjectAliasID(meta) == projectID {
			return imported.Project, true
		}
	}
	return readmodels.ProjectRecord{}, false
}

func workspaceLegacyChatProjectByID(chatID string) (readmodels.ChatRecord, readmodels.ProjectRecord, bool) {
	meta, ok := workspaceLegacySessionByChatID(chatID)
	if !ok {
		return readmodels.ChatRecord{}, readmodels.ProjectRecord{}, false
	}
	imported := legacyimport.ImportSession(meta, nil, legacyimport.ImportOptions{})
	return imported.Chat, imported.Project, true
}

func legacySidebarRow(imported legacyimport.ImportedSession, meta state.SessionMeta, unread bool) readmodels.SidebarChatRow {
	lastMessageAt := imported.Chat.LastMessageAt
	return readmodels.SidebarChatRow{
		ID:               imported.Chat.ID,
		CreationTime:     imported.Chat.CreatedAt,
		ChatID:           imported.Chat.ID,
		Title:            imported.Chat.Title,
		Status:           string(readmodels.StatusIdle),
		Unread:           unread,
		LocalPath:        imported.Project.LocalPath,
		Provider:         imported.Chat.Provider,
		LastMessageAt:    &lastMessageAt,
		HasAutomation:    false,
		CanFork:          imported.Chat.Provider != nil,
		ReadOnly:         false,
		LegacySessionKey: "",
	}
}

func workspaceMaxInt64(values ...int64) int64 {
	var max int64
	for _, value := range values {
		if value > max {
			max = value
		}
	}
	return max
}

func appendWorkspaceStoreEvent(store interface {
	Append(string, events.Event) error
}, stream string, eventType string, timestamp int64, data map[string]any) error {
	event, err := events.NewAt(eventType, timestamp, data)
	if err != nil {
		return err
	}
	return store.Append(stream, event)
}

func sidebarHasChat(group readmodels.SidebarProjectGroup, chatID string) bool {
	for _, chat := range group.Chats {
		if chat.ChatID == chatID {
			return true
		}
	}
	for _, chat := range group.ArchivedChats {
		if chat.ChatID == chatID {
			return true
		}
	}
	return false
}

func sidebarChatTimestamp(chat readmodels.SidebarChatRow) int64 {
	if chat.LastMessageAt != nil {
		return *chat.LastMessageAt
	}
	return chat.CreationTime
}

func groupTimestamp(group readmodels.SidebarProjectGroup) int64 {
	var newest int64
	for _, chat := range group.Chats {
		if timestamp := sidebarChatTimestamp(chat); timestamp > newest {
			newest = timestamp
		}
	}
	return newest
}
