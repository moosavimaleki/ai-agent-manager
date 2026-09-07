package readmodels

import (
	"sort"
	"strings"
	"time"

	"abolqasem/internal/providers/catalog"
	"abolqasem/internal/workspace/events"
	"abolqasem/internal/workspace/transcript"
)

const sidebarRecentWindowMs = 24 * 60 * 60 * 1000

type ProjectRecord struct {
	ID           string  `json:"id"`
	LocalPath    string  `json:"localPath"`
	Title        string  `json:"title"`
	SidebarTitle *string `json:"sidebarTitle,omitempty"`
	CreatedAt    int64   `json:"createdAt"`
	UpdatedAt    int64   `json:"updatedAt"`
	SidebarOrder int64   `json:"sidebarOrder,omitempty"`
	DeletedAt    int64   `json:"deletedAt,omitempty"`
}

type ChatRecord struct {
	ID                      string  `json:"id"`
	ProjectID               string  `json:"projectId"`
	Title                   string  `json:"title"`
	CreatedAt               int64   `json:"createdAt"`
	UpdatedAt               int64   `json:"updatedAt"`
	DeletedAt               int64   `json:"deletedAt,omitempty"`
	ArchivedAt              int64   `json:"archivedAt,omitempty"`
	Pinned                  bool    `json:"pinned,omitempty"`
	PinnedOrder             int64   `json:"pinnedOrder,omitempty"`
	Unread                  bool    `json:"unread"`
	Provider                *string `json:"provider"`
	PlanMode                bool    `json:"planMode"`
	SessionToken            *string `json:"sessionToken"`
	PendingForkSessionToken *string `json:"pendingForkSessionToken,omitempty"`
	HasMessages             bool    `json:"hasMessages,omitempty"`
	LastMessageAt           int64   `json:"lastMessageAt,omitempty"`
	LastTurnOutcome         *string `json:"lastTurnOutcome"`
	TmuxSession             string  `json:"tmuxSession,omitempty"`
	TmuxCommand             string  `json:"tmuxCommand,omitempty"`
	NativeSessionID         string  `json:"nativeSessionId,omitempty"`
	NativeTranscriptPath    string  `json:"nativeTranscriptPath,omitempty"`
	ParentChatID            string  `json:"parentChatId,omitempty"`
	LastSummary             string  `json:"lastSummary,omitempty"`
}

type StoreState struct {
	ProjectsByID           map[string]ProjectRecord
	ProjectIDsByPath       map[string]string
	ChatsByID              map[string]ChatRecord
	QueuedMessagesByChatID map[string][]QueuedChatMessage
}

type AbolqasemStatus string

const (
	StatusIdle           AbolqasemStatus = "idle"
	StatusStarting       AbolqasemStatus = "starting"
	StatusRunning        AbolqasemStatus = "running"
	StatusWaitingForUser AbolqasemStatus = "waiting_for_user"
	StatusFailed         AbolqasemStatus = "failed"
	StatusCancelled      AbolqasemStatus = "cancelled"
)

type ChatAttachment struct {
	ID           string `json:"id"`
	Kind         string `json:"kind"`
	DisplayName  string `json:"displayName"`
	AbsolutePath string `json:"absolutePath"`
	RelativePath string `json:"relativePath"`
	ContentURL   string `json:"contentUrl"`
	MimeType     string `json:"mimeType"`
	Size         int64  `json:"size"`
}

type QueuedChatMessage struct {
	ID            string                `json:"id"`
	Content       string                `json:"content"`
	Attachments   []ChatAttachment      `json:"attachments"`
	CreatedAt     int64                 `json:"createdAt"`
	Provider      *string               `json:"provider,omitempty"`
	Model         string                `json:"model,omitempty"`
	ModelOptions  *catalog.ModelOptions `json:"modelOptions,omitempty"`
	PlanMode      *bool                 `json:"planMode,omitempty"`
	DeliveryState string                `json:"deliveryState,omitempty"`
}

type TranscriptEntry = transcript.Entry

type ChatRuntime struct {
	ChatID                  string          `json:"chatId"`
	ProjectID               string          `json:"projectId"`
	LocalPath               string          `json:"localPath"`
	Title                   string          `json:"title"`
	Status                  AbolqasemStatus `json:"status"`
	IsDraining              bool            `json:"isDraining"`
	Provider                *string         `json:"provider"`
	PlanMode                bool            `json:"planMode"`
	SessionToken            *string         `json:"sessionToken"`
	PendingForkSessionToken *string         `json:"pendingForkSessionToken,omitempty"`
	ReadOnly                bool            `json:"readOnly,omitempty"`
	LegacySessionKey        string          `json:"legacySessionKey,omitempty"`
	TmuxSession             string          `json:"tmuxSession,omitempty"`
	TmuxCommand             string          `json:"tmuxCommand,omitempty"`
	TmuxActive              bool            `json:"tmuxActive"`
	NativeSessionID         string          `json:"nativeSessionId,omitempty"`
	NativeTranscriptPath    string          `json:"nativeTranscriptPath,omitempty"`
	ParentChatID            string          `json:"parentChatId,omitempty"`
	LastSummary             string          `json:"lastSummary,omitempty"`
	CodexLock               CodexLockStatus `json:"codexLock"`
}

// CodexLockStatus describes whether this server can safely write to a Codex
// thread. It is deliberately separate from a turn status: a thread can be
// idle while another Codex process still owns its durable session writer.
type CodexLockStatus struct {
	State                 string `json:"state"`
	SessionID             string `json:"sessionId,omitempty"`
	SessionPath           string `json:"sessionPath,omitempty"`
	OwnerPID              int    `json:"ownerPid,omitempty"`
	OwnerCommand          string `json:"ownerCommand,omitempty"`
	OtherWritableSessions int    `json:"otherWritableSessions,omitempty"`
	ExecutionMode         string `json:"executionMode,omitempty"`
	CanTakeOver           bool   `json:"canTakeOver"`
	CanRelease            bool   `json:"canRelease"`
	Message               string `json:"message,omitempty"`
}

type ChatHistorySnapshot struct {
	HasOlder    bool    `json:"hasOlder"`
	OlderCursor *string `json:"olderCursor"`
	RecentLimit int     `json:"recentLimit"`
}

type ChatTranscriptSnapshot struct {
	Messages []TranscriptEntry   `json:"messages"`
	History  ChatHistorySnapshot `json:"history"`
}

type ChatSnapshot struct {
	Runtime            ChatRuntime                    `json:"runtime"`
	QueuedMessages     []QueuedChatMessage            `json:"queuedMessages"`
	Messages           []TranscriptEntry              `json:"messages"`
	History            ChatHistorySnapshot            `json:"history"`
	AvailableProviders []catalog.ProviderCatalogEntry `json:"availableProviders"`
}

type DiscoveredProject struct {
	LocalPath  string
	Title      string
	ModifiedAt int64
}

type LocalProjectsSnapshot struct {
	Machine  LocalProjectsMachine `json:"machine"`
	Projects []LocalProjectRow    `json:"projects"`
}

type LocalProjectsMachine struct {
	ID          string `json:"id"`
	DisplayName string `json:"displayName"`
	Platform    string `json:"platform"`
}

type LocalProjectRow struct {
	LocalPath    string `json:"localPath"`
	Title        string `json:"title"`
	Source       string `json:"source"`
	LastOpenedAt int64  `json:"lastOpenedAt"`
	ChatCount    int    `json:"chatCount"`
}

type SidebarData struct {
	ProjectGroups []SidebarProjectGroup `json:"projectGroups"`
}

type SidebarProjectGroup struct {
	GroupKey         string           `json:"groupKey"`
	Title            string           `json:"title"`
	RealTitle        string           `json:"realTitle"`
	SidebarTitle     string           `json:"sidebarTitle,omitempty"`
	LocalPath        string           `json:"localPath"`
	Chats            []SidebarChatRow `json:"chats"`
	PreviewChats     []SidebarChatRow `json:"previewChats"`
	OlderChats       []SidebarChatRow `json:"olderChats"`
	ArchivedChats    []SidebarChatRow `json:"archivedChats,omitempty"`
	DefaultCollapsed bool             `json:"defaultCollapsed"`
}

type SidebarChatRow struct {
	ID               string  `json:"_id"`
	CreationTime     int64   `json:"_creationTime"`
	ChatID           string  `json:"chatId"`
	Title            string  `json:"title"`
	Status           string  `json:"status"`
	Unread           bool    `json:"unread"`
	LocalPath        string  `json:"localPath"`
	Provider         *string `json:"provider"`
	LastMessageAt    *int64  `json:"lastMessageAt,omitempty"`
	Preview          string  `json:"preview,omitempty"`
	HasAutomation    bool    `json:"hasAutomation"`
	CanFork          bool    `json:"canFork,omitempty"`
	ReadOnly         bool    `json:"readOnly,omitempty"`
	LegacySessionKey string  `json:"legacySessionKey,omitempty"`
	Pinned           bool    `json:"pinned,omitempty"`
	PinnedOrder      int64   `json:"pinnedOrder,omitempty"`
}

func EmptyState() StoreState {
	return StoreState{
		ProjectsByID:           map[string]ProjectRecord{},
		ProjectIDsByPath:       map[string]string{},
		ChatsByID:              map[string]ChatRecord{},
		QueuedMessagesByChatID: map[string][]QueuedChatMessage{},
	}
}

func Apply(state StoreState, event events.Event) StoreState {
	switch event.Type {
	case events.TypeProjectOpened:
		var data struct {
			ProjectID string `json:"projectId"`
			LocalPath string `json:"localPath"`
			Title     string `json:"title"`
		}
		if event.DecodeData(&data) != nil || data.ProjectID == "" {
			return state
		}
		record := state.ProjectsByID[data.ProjectID]
		if record.CreatedAt == 0 {
			record.CreatedAt = event.Timestamp
		}
		record.ID = data.ProjectID
		record.LocalPath = data.LocalPath
		record.Title = data.Title
		record.UpdatedAt = event.Timestamp
		record.DeletedAt = 0
		state.ProjectsByID[record.ID] = record
		if record.LocalPath != "" {
			state.ProjectIDsByPath[record.LocalPath] = record.ID
		}
	case events.TypeProjectSidebarRenamed:
		var data struct {
			ProjectID string  `json:"projectId"`
			Title     *string `json:"title"`
		}
		if event.DecodeData(&data) != nil || data.ProjectID == "" {
			return state
		}
		record := state.ProjectsByID[data.ProjectID]
		record.SidebarTitle = data.Title
		record.UpdatedAt = event.Timestamp
		state.ProjectsByID[data.ProjectID] = record
	case events.TypeProjectSidebarReordered:
		var data struct {
			ProjectIDs []string `json:"projectIds"`
		}
		if event.DecodeData(&data) != nil {
			return state
		}
		for index, projectID := range data.ProjectIDs {
			record, ok := state.ProjectsByID[projectID]
			if !ok || record.DeletedAt != 0 {
				continue
			}
			record.SidebarOrder = int64(index + 1)
			state.ProjectsByID[projectID] = record
		}
	case events.TypeProjectRemoved:
		var data struct {
			ProjectID string `json:"projectId"`
		}
		if event.DecodeData(&data) != nil || data.ProjectID == "" {
			return state
		}
		record := state.ProjectsByID[data.ProjectID]
		record.DeletedAt = event.Timestamp
		record.UpdatedAt = event.Timestamp
		state.ProjectsByID[data.ProjectID] = record
	case events.TypeChatCreated:
		var data struct {
			ChatID               string `json:"chatId"`
			ProjectID            string `json:"projectId"`
			Title                string `json:"title"`
			Provider             string `json:"provider"`
			TmuxSession          string `json:"tmuxSession"`
			TmuxCommand          string `json:"tmuxCommand"`
			NativeSessionID      string `json:"nativeSessionId"`
			NativeTranscriptPath string `json:"nativeTranscriptPath"`
			ParentChatID         string `json:"parentChatId"`
			LastSummary          string `json:"lastSummary"`
		}
		if event.DecodeData(&data) != nil || data.ChatID == "" {
			return state
		}
		record := state.ChatsByID[data.ChatID]
		if record.CreatedAt == 0 {
			record.CreatedAt = event.Timestamp
		}
		record.ID = data.ChatID
		record.ProjectID = data.ProjectID
		record.Title = data.Title
		if strings.TrimSpace(data.Provider) != "" {
			record.Provider = &data.Provider
		}
		record.TmuxSession = data.TmuxSession
		record.TmuxCommand = data.TmuxCommand
		record.NativeSessionID = data.NativeSessionID
		record.NativeTranscriptPath = data.NativeTranscriptPath
		record.ParentChatID = data.ParentChatID
		record.LastSummary = data.LastSummary
		record.UpdatedAt = event.Timestamp
		record.Unread = false
		state.ChatsByID[record.ID] = record
		state = touchProjectTimestampForChat(state, record, event.Timestamp)
	case events.TypeChatRenamed:
		var data struct {
			ChatID string `json:"chatId"`
			Title  string `json:"title"`
		}
		if event.DecodeData(&data) != nil || data.ChatID == "" {
			return state
		}
		record := state.ChatsByID[data.ChatID]
		record.Title = data.Title
		record.UpdatedAt = event.Timestamp
		state.ChatsByID[data.ChatID] = record
		state = touchProjectTimestampForChat(state, record, event.Timestamp)
	case events.TypeChatDeleted:
		state = markChatTimestamp(state, event, func(record *ChatRecord) { record.DeletedAt = event.Timestamp })
	case events.TypeChatArchived:
		state = markChatTimestamp(state, event, func(record *ChatRecord) { record.ArchivedAt = event.Timestamp })
	case events.TypeChatUnarchived:
		state = markChatTimestamp(state, event, func(record *ChatRecord) { record.ArchivedAt = 0 })
	case events.TypeChatPinned:
		var data struct {
			ChatID string `json:"chatId"`
			Pinned bool   `json:"pinned"`
		}
		if event.DecodeData(&data) != nil || data.ChatID == "" {
			return state
		}
		record := state.ChatsByID[data.ChatID]
		record.Pinned = data.Pinned
		if data.Pinned {
			record.PinnedOrder = event.Timestamp
		} else {
			record.PinnedOrder = 0
		}
		record.UpdatedAt = event.Timestamp
		state.ChatsByID[data.ChatID] = record
		state = touchProjectTimestampForChat(state, record, event.Timestamp)
	case events.TypeChatPinnedReordered:
		var data struct {
			ChatIDs []string `json:"chatIds"`
		}
		if event.DecodeData(&data) != nil {
			return state
		}
		for index, chatID := range data.ChatIDs {
			record, ok := state.ChatsByID[chatID]
			if !ok || !record.Pinned {
				continue
			}
			// Pin order belongs to the user rather than chat activity, so it
			// deliberately does not change UpdatedAt or project recency.
			record.PinnedOrder = event.Timestamp + int64(len(data.ChatIDs)-index)
			state.ChatsByID[chatID] = record
		}
	case events.TypeChatProviderSet:
		var data struct {
			ChatID   string `json:"chatId"`
			Provider string `json:"provider"`
		}
		if event.DecodeData(&data) != nil || data.ChatID == "" {
			return state
		}
		record := state.ChatsByID[data.ChatID]
		record.Provider = &data.Provider
		record.UpdatedAt = event.Timestamp
		state.ChatsByID[data.ChatID] = record
		state = touchProjectTimestampForChat(state, record, event.Timestamp)
	case events.TypeChatPlanModeSet:
		var data struct {
			ChatID   string `json:"chatId"`
			PlanMode bool   `json:"planMode"`
		}
		if event.DecodeData(&data) != nil || data.ChatID == "" {
			return state
		}
		record := state.ChatsByID[data.ChatID]
		record.PlanMode = data.PlanMode
		record.UpdatedAt = event.Timestamp
		state.ChatsByID[data.ChatID] = record
		state = touchProjectTimestampForChat(state, record, event.Timestamp)
	case events.TypeChatReadStateSet:
		var data struct {
			ChatID string `json:"chatId"`
			Unread bool   `json:"unread"`
		}
		if event.DecodeData(&data) != nil || data.ChatID == "" {
			return state
		}
		record := state.ChatsByID[data.ChatID]
		record.Unread = data.Unread
		record.UpdatedAt = event.Timestamp
		state.ChatsByID[data.ChatID] = record
		state = touchProjectTimestampForChat(state, record, event.Timestamp)
	case events.TypeChatRuntimeSet:
		var data struct {
			ChatID               string `json:"chatId"`
			Provider             string `json:"provider"`
			TmuxSession          string `json:"tmuxSession"`
			TmuxCommand          string `json:"tmuxCommand"`
			NativeSessionID      string `json:"nativeSessionId"`
			NativeTranscriptPath string `json:"nativeTranscriptPath"`
			ParentChatID         string `json:"parentChatId"`
			LastSummary          string `json:"lastSummary"`
		}
		if event.DecodeData(&data) != nil || data.ChatID == "" {
			return state
		}
		record := state.ChatsByID[data.ChatID]
		if data.Provider != "" {
			record.Provider = &data.Provider
		}
		if data.TmuxSession != "" {
			record.TmuxSession = data.TmuxSession
		}
		if data.TmuxCommand != "" {
			record.TmuxCommand = data.TmuxCommand
		}
		if data.NativeSessionID != "" {
			record.NativeSessionID = data.NativeSessionID
		}
		if data.NativeTranscriptPath != "" {
			record.NativeTranscriptPath = data.NativeTranscriptPath
		}
		if data.ParentChatID != "" {
			record.ParentChatID = data.ParentChatID
		}
		if data.LastSummary != "" {
			record.LastSummary = data.LastSummary
		}
		record.UpdatedAt = event.Timestamp
		state.ChatsByID[data.ChatID] = record
		state = touchProjectTimestampForChat(state, record, event.Timestamp)
	case events.TypeMessageAppended:
		var data struct {
			ChatID string          `json:"chatId"`
			Entry  TranscriptEntry `json:"entry"`
		}
		if event.DecodeData(&data) != nil || data.ChatID == "" {
			return state
		}
		record := state.ChatsByID[data.ChatID]
		record.HasMessages = true
		messageTimestamp := transcriptEntryActivityTimestamp(data.Entry, event.Timestamp)
		if messageTimestamp > 0 {
			record.LastMessageAt = maxInt64(record.LastMessageAt, messageTimestamp)
			if messageTimestamp > record.UpdatedAt {
				record.UpdatedAt = messageTimestamp
			}
		}
		state.ChatsByID[data.ChatID] = record
		state = touchProjectTimestampForChat(state, record, record.UpdatedAt)
	case events.TypeChatRestoredToCheckpoint:
		var data struct {
			ChatID   string            `json:"chatId"`
			Messages []TranscriptEntry `json:"messages"`
		}
		if event.DecodeData(&data) != nil || data.ChatID == "" {
			return state
		}
		record := state.ChatsByID[data.ChatID]
		record.HasMessages = len(data.Messages) > 0
		record.LastMessageAt = lastTranscriptEntryTimestamp(data.Messages)
		record.UpdatedAt = maxInt64(event.Timestamp, record.LastMessageAt)
		state.ChatsByID[data.ChatID] = record
		state = touchProjectTimestampForChat(state, record, record.UpdatedAt)
	case events.TypeQueuedMessageEnqueued:
		var data struct {
			ChatID  string            `json:"chatId"`
			Message QueuedChatMessage `json:"message"`
		}
		if event.DecodeData(&data) != nil || data.ChatID == "" {
			return state
		}
		for _, existing := range state.QueuedMessagesByChatID[data.ChatID] {
			if existing.ID == data.Message.ID {
				return state
			}
		}
		state.QueuedMessagesByChatID[data.ChatID] = append(state.QueuedMessagesByChatID[data.ChatID], cloneQueuedMessage(data.Message))
		record := state.ChatsByID[data.ChatID]
		record.UpdatedAt = event.Timestamp
		state.ChatsByID[data.ChatID] = record
		state = touchProjectTimestampForChat(state, record, event.Timestamp)
	case events.TypeQueuedMessageUpdated:
		var data struct {
			ChatID          string `json:"chatId"`
			QueuedMessageID string `json:"queuedMessageId"`
			Content         string `json:"content"`
		}
		if event.DecodeData(&data) != nil || data.ChatID == "" {
			return state
		}
		existing := state.QueuedMessagesByChatID[data.ChatID]
		for index := range existing {
			if existing[index].ID == data.QueuedMessageID {
				existing[index].Content = data.Content
			}
		}
		state.QueuedMessagesByChatID[data.ChatID] = existing
	case events.TypeQueuedMessageSteered:
		var data struct {
			ChatID          string `json:"chatId"`
			QueuedMessageID string `json:"queuedMessageId"`
		}
		if event.DecodeData(&data) != nil || data.ChatID == "" {
			return state
		}
		existing := state.QueuedMessagesByChatID[data.ChatID]
		for index := range existing {
			if existing[index].ID == data.QueuedMessageID {
				existing[index].DeliveryState = "steering"
			}
		}
		state.QueuedMessagesByChatID[data.ChatID] = existing
	case events.TypeQueuedMessageRemoved:
		var data struct {
			ChatID          string `json:"chatId"`
			QueuedMessageID string `json:"queuedMessageId"`
		}
		if event.DecodeData(&data) != nil || data.ChatID == "" {
			return state
		}
		existing := state.QueuedMessagesByChatID[data.ChatID]
		next := existing[:0]
		for _, message := range existing {
			if message.ID != data.QueuedMessageID {
				next = append(next, message)
			}
		}
		if len(next) == 0 {
			delete(state.QueuedMessagesByChatID, data.ChatID)
		} else {
			state.QueuedMessagesByChatID[data.ChatID] = next
		}
		record := state.ChatsByID[data.ChatID]
		record.UpdatedAt = event.Timestamp
		state.ChatsByID[data.ChatID] = record
		state = touchProjectTimestampForChat(state, record, event.Timestamp)
	case events.TypeTurnStarted:
		state = markChatTimestamp(state, event, nil)
	case events.TypeTurnFinished:
		outcome := "success"
		state = markChatTimestamp(state, event, func(record *ChatRecord) {
			record.Unread = true
			record.LastTurnOutcome = &outcome
		})
	case events.TypeTurnFailed:
		outcome := "failed"
		state = markChatTimestamp(state, event, func(record *ChatRecord) {
			record.Unread = true
			record.LastTurnOutcome = &outcome
		})
	case events.TypeTurnCancelled:
		outcome := "cancelled"
		state = markChatTimestamp(state, event, func(record *ChatRecord) {
			record.LastTurnOutcome = &outcome
		})
	case events.TypeSessionTokenSet:
		var data struct {
			ChatID       string  `json:"chatId"`
			SessionToken *string `json:"sessionToken"`
		}
		if event.DecodeData(&data) != nil || data.ChatID == "" {
			return state
		}
		record := state.ChatsByID[data.ChatID]
		record.SessionToken = data.SessionToken
		record.UpdatedAt = event.Timestamp
		state.ChatsByID[data.ChatID] = record
		state = touchProjectTimestampForChat(state, record, event.Timestamp)
	case events.TypePendingForkSessionTokenSet:
		var data struct {
			ChatID                  string  `json:"chatId"`
			PendingForkSessionToken *string `json:"pendingForkSessionToken"`
		}
		if event.DecodeData(&data) != nil || data.ChatID == "" {
			return state
		}
		record := state.ChatsByID[data.ChatID]
		record.PendingForkSessionToken = data.PendingForkSessionToken
		record.UpdatedAt = event.Timestamp
		state.ChatsByID[data.ChatID] = record
		state = touchProjectTimestampForChat(state, record, event.Timestamp)
	}
	return state
}

func Replay(eventsList []events.Event) StoreState {
	state := EmptyState()
	for _, event := range eventsList {
		state = Apply(state, event)
	}
	return state
}

func DeriveSidebarData(state StoreState) SidebarData {
	return DeriveSidebarDataWithStatus(state, nil)
}

func DeriveSidebarDataWithStatus(state StoreState, activeStatuses map[string]AbolqasemStatus) SidebarData {
	projects := make([]ProjectRecord, 0, len(state.ProjectsByID))
	for _, project := range state.ProjectsByID {
		if project.DeletedAt != 0 {
			continue
		}
		projects = append(projects, project)
	}
	sort.Slice(projects, func(i, j int) bool {
		if projects[i].SidebarOrder != projects[j].SidebarOrder {
			if projects[j].SidebarOrder == 0 {
				return true
			}
			if projects[i].SidebarOrder == 0 {
				return false
			}
			return projects[i].SidebarOrder < projects[j].SidebarOrder
		}
		return projects[i].UpdatedAt > projects[j].UpdatedAt
	})

	groups := make([]SidebarProjectGroup, 0, len(projects))
	for _, project := range projects {
		title := project.Title
		sidebarTitle := ""
		if project.SidebarTitle != nil && *project.SidebarTitle != "" {
			title = *project.SidebarTitle
			sidebarTitle = *project.SidebarTitle
		}
		group := SidebarProjectGroup{
			GroupKey:         project.ID,
			Title:            title,
			RealTitle:        project.Title,
			SidebarTitle:     sidebarTitle,
			LocalPath:        project.LocalPath,
			Chats:            []SidebarChatRow{},
			PreviewChats:     []SidebarChatRow{},
			OlderChats:       []SidebarChatRow{},
			ArchivedChats:    []SidebarChatRow{},
			DefaultCollapsed: false,
		}
		for _, chat := range chatsForProject(state, project.ID) {
			row := sidebarRow(project, chat, activeStatuses[chat.ID])
			if chat.ArchivedAt != 0 {
				group.ArchivedChats = append(group.ArchivedChats, row)
				continue
			}
			group.Chats = append(group.Chats, row)
		}
		sort.SliceStable(group.Chats, func(i, j int) bool {
			if group.Chats[i].Pinned != group.Chats[j].Pinned {
				return group.Chats[i].Pinned
			}
			return sidebarChatRowTimestamp(group.Chats[i]) > sidebarChatRowTimestamp(group.Chats[j])
		})
		PopulateSidebarBuckets(&group, time.Now().UnixMilli())
		groups = append(groups, group)
	}
	return SidebarData{ProjectGroups: groups}
}

func PopulateSidebarBuckets(group *SidebarProjectGroup, nowMs int64) {
	if group == nil {
		return
	}
	if len(group.Chats) == 0 {
		group.PreviewChats = []SidebarChatRow{}
		group.OlderChats = []SidebarChatRow{}
		group.DefaultCollapsed = false
		return
	}

	recent := make([]SidebarChatRow, 0, len(group.Chats))
	for _, chat := range group.Chats {
		if isSidebarChatRecent(sidebarChatRowTimestamp(chat), nowMs) {
			recent = append(recent, chat)
		}
	}

	preview := recent
	if len(preview) == 0 {
		limit := 5
		if len(group.Chats) < limit {
			limit = len(group.Chats)
		}
		preview = append([]SidebarChatRow(nil), group.Chats[:limit]...)
	}

	previewIDs := make(map[string]bool, len(preview))
	for _, chat := range preview {
		previewIDs[chat.ChatID] = true
	}
	older := make([]SidebarChatRow, 0, len(group.Chats)-len(previewIDs))
	for _, chat := range group.Chats {
		if !previewIDs[chat.ChatID] {
			older = append(older, chat)
		}
	}

	group.PreviewChats = preview
	group.OlderChats = older
	group.DefaultCollapsed = len(recent) == 0
}

func DeriveStatus(chat ChatRecord, activeStatus AbolqasemStatus) AbolqasemStatus {
	if activeStatus != "" {
		return activeStatus
	}
	if chat.LastTurnOutcome != nil && *chat.LastTurnOutcome == "failed" {
		return StatusFailed
	}
	return StatusIdle
}

func DeriveChatSnapshot(
	state StoreState,
	activeStatuses map[string]AbolqasemStatus,
	drainingChatIDs map[string]bool,
	chatID string,
	transcript ChatTranscriptSnapshot,
) *ChatSnapshot {
	chat, ok := state.ChatsByID[chatID]
	if !ok || chat.DeletedAt != 0 {
		return nil
	}
	project, ok := state.ProjectsByID[chat.ProjectID]
	if !ok || project.DeletedAt != 0 {
		return nil
	}

	queuedMessages := state.QueuedMessagesByChatID[chat.ID]
	clonedQueued := make([]QueuedChatMessage, 0, len(queuedMessages))
	for _, message := range queuedMessages {
		clonedQueued = append(clonedQueued, cloneQueuedMessage(message))
	}

	return &ChatSnapshot{
		Runtime: ChatRuntime{
			ChatID:                  chat.ID,
			ProjectID:               project.ID,
			LocalPath:               project.LocalPath,
			Title:                   chat.Title,
			Status:                  DeriveStatus(chat, activeStatuses[chat.ID]),
			IsDraining:              drainingChatIDs[chat.ID],
			Provider:                chat.Provider,
			PlanMode:                chat.PlanMode,
			SessionToken:            chat.SessionToken,
			PendingForkSessionToken: chat.PendingForkSessionToken,
			TmuxSession:             chat.TmuxSession,
			TmuxCommand:             chat.TmuxCommand,
			NativeSessionID:         chat.NativeSessionID,
			NativeTranscriptPath:    chat.NativeTranscriptPath,
			ParentChatID:            chat.ParentChatID,
			LastSummary:             chat.LastSummary,
		},
		QueuedMessages:     clonedQueued,
		Messages:           transcript.Messages,
		History:            transcript.History,
		AvailableProviders: catalog.ServerProviders(),
	}
}

func DeriveLocalProjectsSnapshot(
	state StoreState,
	discoveredProjects []DiscoveredProject,
	machineName string,
	platform string,
) LocalProjectsSnapshot {
	projects := map[string]LocalProjectRow{}

	for _, project := range discoveredProjects {
		if project.LocalPath == "" {
			continue
		}
		projects[project.LocalPath] = LocalProjectRow{
			LocalPath:    project.LocalPath,
			Title:        project.Title,
			Source:       "discovered",
			LastOpenedAt: project.ModifiedAt,
			ChatCount:    0,
		}
	}

	for _, project := range state.ProjectsByID {
		if project.DeletedAt != 0 {
			continue
		}
		chatCount := 0
		lastOpenedAt := project.UpdatedAt
		for _, chat := range state.ChatsByID {
			if chat.ProjectID != project.ID || chat.DeletedAt != 0 || chat.ArchivedAt != 0 {
				continue
			}
			chatCount++
			if getSidebarChatSortTimestamp(chat) > lastOpenedAt {
				lastOpenedAt = getSidebarChatSortTimestamp(chat)
			}
		}
		projects[project.LocalPath] = LocalProjectRow{
			LocalPath:    project.LocalPath,
			Title:        project.Title,
			Source:       "saved",
			LastOpenedAt: lastOpenedAt,
			ChatCount:    chatCount,
		}
	}

	rows := make([]LocalProjectRow, 0, len(projects))
	for _, project := range projects {
		rows = append(rows, project)
	}
	sort.Slice(rows, func(i, j int) bool {
		return rows[i].LastOpenedAt > rows[j].LastOpenedAt
	})

	return LocalProjectsSnapshot{
		Machine: LocalProjectsMachine{
			ID:          "local",
			DisplayName: machineName,
			Platform:    platform,
		},
		Projects: rows,
	}
}

func chatsForProject(state StoreState, projectID string) []ChatRecord {
	chats := make([]ChatRecord, 0)
	for _, chat := range state.ChatsByID {
		if chat.ProjectID != projectID || chat.DeletedAt != 0 {
			continue
		}
		chats = append(chats, chat)
	}
	sort.Slice(chats, func(i, j int) bool {
		return getSidebarChatSortTimestamp(chats[i]) > getSidebarChatSortTimestamp(chats[j])
	})
	return chats
}

func getSidebarChatSortTimestamp(chat ChatRecord) int64 {
	return maxInt64(chat.LastMessageAt, chat.UpdatedAt, chat.CreatedAt)
}

func sidebarChatRowTimestamp(chat SidebarChatRow) int64 {
	if chat.LastMessageAt != nil {
		return *chat.LastMessageAt
	}
	return chat.CreationTime
}

func isSidebarChatRecent(timestamp int64, nowMs int64) bool {
	if timestamp == 0 {
		return false
	}
	return maxInt64(0, nowMs-timestamp) < sidebarRecentWindowMs
}

func maxInt64(values ...int64) int64 {
	var max int64
	for _, value := range values {
		if value > max {
			max = value
		}
	}
	return max
}

func sidebarRow(project ProjectRecord, chat ChatRecord, activeStatus AbolqasemStatus) SidebarChatRow {
	var lastMessageAt *int64
	sortTimestamp := getSidebarChatSortTimestamp(chat)
	if sortTimestamp != 0 {
		lastMessageAt = &sortTimestamp
	}
	return SidebarChatRow{
		ID:            chat.ID,
		CreationTime:  chat.CreatedAt,
		ChatID:        chat.ID,
		Title:         chat.Title,
		Status:        string(DeriveStatus(chat, activeStatus)),
		Unread:        chat.Unread,
		LocalPath:     project.LocalPath,
		Provider:      chat.Provider,
		LastMessageAt: lastMessageAt,
		Preview:       chat.LastSummary,
		HasAutomation: false,
		CanFork:       chat.Provider != nil,
		Pinned:        chat.Pinned,
		PinnedOrder:   chat.PinnedOrder,
	}
}

func markChatTimestamp(state StoreState, event events.Event, update func(*ChatRecord)) StoreState {
	var data struct {
		ChatID string `json:"chatId"`
	}
	if event.DecodeData(&data) != nil || data.ChatID == "" {
		return state
	}
	record := state.ChatsByID[data.ChatID]
	if update != nil {
		update(&record)
	}
	record.UpdatedAt = event.Timestamp
	state.ChatsByID[data.ChatID] = record
	state = touchProjectTimestampForChat(state, record, event.Timestamp)
	return state
}

func touchProjectTimestampForChat(state StoreState, chat ChatRecord, timestamp int64) StoreState {
	if chat.ProjectID == "" {
		return state
	}
	project, ok := state.ProjectsByID[chat.ProjectID]
	if !ok {
		return state
	}
	if timestamp <= project.UpdatedAt {
		return state
	}
	project.UpdatedAt = timestamp
	state.ProjectsByID[chat.ProjectID] = project
	return state
}

func lastUserPromptTimestamp(entries []TranscriptEntry) int64 {
	for index := len(entries) - 1; index >= 0; index-- {
		entry := entries[index]
		if transcript.Kind(entry) != transcript.KindUserPrompt {
			continue
		}
		if createdAt, ok := numberAsInt64(entry["createdAt"]); ok {
			return createdAt
		}
	}
	return 0
}

func lastTranscriptEntryTimestamp(entries []TranscriptEntry) int64 {
	for index := len(entries) - 1; index >= 0; index-- {
		if timestamp := transcriptEntryTimestamp(entries[index]); timestamp > 0 {
			return timestamp
		}
	}
	return 0
}

func transcriptEntryActivityTimestamp(entry TranscriptEntry, fallback int64) int64 {
	if timestamp := transcriptEntryTimestamp(entry); timestamp > 0 {
		return timestamp
	}
	return fallback
}

func transcriptEntryTimestamp(entry TranscriptEntry) int64 {
	if createdAt, ok := numberAsInt64(entry["createdAt"]); ok {
		return createdAt
	}
	return 0
}

func cloneQueuedMessage(message QueuedChatMessage) QueuedChatMessage {
	cloned := message
	cloned.Attachments = append(make([]ChatAttachment, 0, len(message.Attachments)), message.Attachments...)
	return cloned
}

func numberAsInt64(value any) (int64, bool) {
	switch typed := value.(type) {
	case int64:
		return typed, true
	case int:
		return int64(typed), true
	case float64:
		return int64(typed), true
	default:
		return 0, false
	}
}
