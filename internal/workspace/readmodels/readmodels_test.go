package readmodels

import (
	"testing"

	"abolqasem/internal/providers/catalog"
	"abolqasem/internal/workspace/events"
)

func TestDeriveSidebarData(t *testing.T) {
	projectEvent, err := events.NewAt(events.TypeProjectOpened, 100, map[string]any{
		"projectId": "project-1",
		"localPath": "/tmp/project",
		"title":     "project",
	})
	if err != nil {
		t.Fatalf("NewAt project returned error: %v", err)
	}
	chatEvent, err := events.NewAt(events.TypeChatCreated, 200, map[string]any{
		"chatId":    "chat-1",
		"projectId": "project-1",
		"title":     "first chat",
	})
	if err != nil {
		t.Fatalf("NewAt chat returned error: %v", err)
	}

	state := Replay([]events.Event{projectEvent, chatEvent})
	sidebar := DeriveSidebarData(state)

	if len(sidebar.ProjectGroups) != 1 {
		t.Fatalf("expected 1 project group, got %d", len(sidebar.ProjectGroups))
	}
	group := sidebar.ProjectGroups[0]
	if group.GroupKey != "project-1" {
		t.Fatalf("expected project-1, got %q", group.GroupKey)
	}
	if len(group.Chats) != 1 {
		t.Fatalf("expected 1 chat, got %d", len(group.Chats))
	}
	if len(group.PreviewChats) != 1 {
		t.Fatalf("expected 1 preview chat, got %d", len(group.PreviewChats))
	}
	if group.Chats[0].ChatID != "chat-1" {
		t.Fatalf("expected chat-1, got %q", group.Chats[0].ChatID)
	}
}

func TestPinnedChatsArePersistedAndSortedFirst(t *testing.T) {
	project, _ := events.NewAt(events.TypeProjectOpened, 100, map[string]any{"projectId": "p", "localPath": "/tmp/p", "title": "p"})
	first, _ := events.NewAt(events.TypeChatCreated, 200, map[string]any{"chatId": "old", "projectId": "p", "title": "old"})
	second, _ := events.NewAt(events.TypeChatCreated, 300, map[string]any{"chatId": "new", "projectId": "p", "title": "new"})
	pinned, _ := events.NewAt(events.TypeChatPinned, 400, map[string]any{"chatId": "old", "pinned": true})
	state := Replay([]events.Event{project, first, second, pinned})
	group := DeriveSidebarData(state).ProjectGroups[0]
	if len(group.Chats) != 2 || group.Chats[0].ChatID != "old" || !group.Chats[0].Pinned {
		t.Fatalf("expected pinned chat first: %#v", group.Chats)
	}
}

func TestPinnedChatReorderPersistsOrderWithoutChangingChatActivity(t *testing.T) {
	project, _ := events.NewAt(events.TypeProjectOpened, 100, map[string]any{"projectId": "p", "localPath": "/tmp/p", "title": "p"})
	first, _ := events.NewAt(events.TypeChatCreated, 200, map[string]any{"chatId": "first", "projectId": "p", "title": "first"})
	second, _ := events.NewAt(events.TypeChatCreated, 300, map[string]any{"chatId": "second", "projectId": "p", "title": "second"})
	pinFirst, _ := events.NewAt(events.TypeChatPinned, 400, map[string]any{"chatId": "first", "pinned": true})
	pinSecond, _ := events.NewAt(events.TypeChatPinned, 450, map[string]any{"chatId": "second", "pinned": true})
	reorder, _ := events.NewAt(events.TypeChatPinnedReordered, 500, map[string]any{"chatIds": []string{"first", "second"}})

	state := Replay([]events.Event{project, first, second, pinFirst, pinSecond, reorder})
	if state.ChatsByID["first"].PinnedOrder <= state.ChatsByID["second"].PinnedOrder {
		t.Fatalf("expected first to have the higher pinned rank: %#v", state.ChatsByID)
	}
	if state.ChatsByID["first"].UpdatedAt != 400 || state.ChatsByID["second"].UpdatedAt != 450 {
		t.Fatalf("pin reorder must not change chat activity timestamps: %#v", state.ChatsByID)
	}
}

func TestReplayIgnoresDuplicateQueuedMessageEventIDs(t *testing.T) {
	queued, err := events.NewAt(events.TypeQueuedMessageEnqueued, 100, map[string]any{
		"chatId": "chat-1",
		"message": map[string]any{
			"id":          "queued-1",
			"content":     "follow up",
			"attachments": []any{},
			"createdAt":   int64(100),
		},
	})
	if err != nil {
		t.Fatalf("NewAt queued message returned error: %v", err)
	}

	state := Replay([]events.Event{queued, queued})
	if messages := state.QueuedMessagesByChatID["chat-1"]; len(messages) != 1 || messages[0].ID != "queued-1" {
		t.Fatalf("expected one queued message after duplicate event replay, got %#v", messages)
	}
}

func TestChatRuntimeMetadataFlowsToSnapshot(t *testing.T) {
	projectEvent, _ := events.NewAt(events.TypeProjectOpened, 100, map[string]any{
		"projectId": "project-1",
		"localPath": "/tmp/project",
		"title":     "project",
	})
	chatEvent, _ := events.NewAt(events.TypeChatCreated, 200, map[string]any{
		"chatId":      "chat-1",
		"projectId":   "project-1",
		"title":       "first chat",
		"tmuxSession": "abolqasem-chat-1",
	})
	runtimeEvent, _ := events.NewAt(events.TypeChatRuntimeSet, 300, map[string]any{
		"chatId":               "chat-1",
		"provider":             "claude",
		"tmuxCommand":          "claude --permission-mode plan",
		"nativeSessionId":      "thread-1",
		"nativeTranscriptPath": "/tmp/thread.jsonl",
		"parentChatId":         "chat-parent",
		"lastSummary":          "latest state",
	})

	snapshot := DeriveChatSnapshot(
		Replay([]events.Event{projectEvent, chatEvent, runtimeEvent}),
		nil,
		nil,
		"chat-1",
		ChatTranscriptSnapshot{},
	)
	if snapshot == nil {
		t.Fatal("expected chat snapshot")
	}
	runtime := snapshot.Runtime
	if runtime.Provider == nil || *runtime.Provider != "claude" || runtime.TmuxCommand != "claude --permission-mode plan" || runtime.TmuxSession != "abolqasem-chat-1" || runtime.NativeSessionID != "thread-1" || runtime.NativeTranscriptPath != "/tmp/thread.jsonl" || runtime.ParentChatID != "chat-parent" || runtime.LastSummary != "latest state" {
		t.Fatalf("unexpected runtime metadata: %#v", runtime)
	}
}

func TestDeriveSidebarDataSkipsDeletedProject(t *testing.T) {
	opened, err := events.NewAt(events.TypeProjectOpened, 100, map[string]any{
		"projectId": "project-1",
		"localPath": "/tmp/project",
		"title":     "project",
	})
	if err != nil {
		t.Fatalf("NewAt opened returned error: %v", err)
	}
	removed, err := events.NewAt(events.TypeProjectRemoved, 200, map[string]any{
		"projectId": "project-1",
	})
	if err != nil {
		t.Fatalf("NewAt removed returned error: %v", err)
	}

	sidebar := DeriveSidebarData(Replay([]events.Event{opened, removed}))
	if len(sidebar.ProjectGroups) != 0 {
		t.Fatalf("expected no project groups, got %d", len(sidebar.ProjectGroups))
	}
}

func TestDeriveSidebarDataOrdersProjectsByLatestChatActivity(t *testing.T) {
	projectOneOpened, _ := events.NewAt(events.TypeProjectOpened, 100, map[string]any{
		"projectId": "project-1",
		"localPath": "/tmp/project-1",
		"title":     "project 1",
	})
	projectTwoOpened, _ := events.NewAt(events.TypeProjectOpened, 200, map[string]any{
		"projectId": "project-2",
		"localPath": "/tmp/project-2",
		"title":     "project 2",
	})
	chatOneCreated, _ := events.NewAt(events.TypeChatCreated, 300, map[string]any{
		"chatId":    "chat-1",
		"projectId": "project-1",
		"title":     "chat 1",
	})
	chatTwoCreated, _ := events.NewAt(events.TypeChatCreated, 400, map[string]any{
		"chatId":    "chat-2",
		"projectId": "project-2",
		"title":     "chat 2",
	})
	projectOneMessage, _ := events.NewAt(events.TypeMessageAppended, 500, map[string]any{
		"chatId": "chat-1",
		"entry": map[string]any{
			"kind":      "user_prompt",
			"content":   "latest activity",
			"createdAt": int64(900),
		},
	})

	sidebar := DeriveSidebarData(Replay([]events.Event{
		projectOneOpened,
		projectTwoOpened,
		chatOneCreated,
		chatTwoCreated,
		projectOneMessage,
	}))

	if len(sidebar.ProjectGroups) != 2 {
		t.Fatalf("expected 2 project groups, got %d", len(sidebar.ProjectGroups))
	}
	if sidebar.ProjectGroups[0].GroupKey != "project-1" {
		t.Fatalf("expected project-1 to sort first after latest chat activity, got %#v", sidebar.ProjectGroups)
	}
	if sidebar.ProjectGroups[1].GroupKey != "project-2" {
		t.Fatalf("expected project-2 to sort second, got %#v", sidebar.ProjectGroups)
	}
}

func TestDeriveSidebarDataSeparatesArchivedChats(t *testing.T) {
	opened, _ := events.NewAt(events.TypeProjectOpened, 100, map[string]any{
		"projectId": "project-1",
		"localPath": "/tmp/project",
		"title":     "project",
	})
	created, _ := events.NewAt(events.TypeChatCreated, 200, map[string]any{
		"chatId":    "chat-1",
		"projectId": "project-1",
		"title":     "first chat",
	})
	archived, _ := events.NewAt(events.TypeChatArchived, 300, map[string]any{
		"chatId": "chat-1",
	})

	sidebar := DeriveSidebarData(Replay([]events.Event{opened, created, archived}))
	if len(sidebar.ProjectGroups) != 1 {
		t.Fatalf("expected 1 project group, got %d", len(sidebar.ProjectGroups))
	}
	group := sidebar.ProjectGroups[0]
	if len(group.Chats) != 0 {
		t.Fatalf("expected no active chats, got %d", len(group.Chats))
	}
	if len(group.ArchivedChats) != 1 {
		t.Fatalf("expected 1 archived chat, got %d", len(group.ArchivedChats))
	}
}

func TestPopulateSidebarBucketsUsesRecentChatsOrFiveFallback(t *testing.T) {
	now := int64(1700000000000)
	recent := now - 60*60*1000
	old := now - 48*60*60*1000
	group := SidebarProjectGroup{
		Chats: []SidebarChatRow{
			{ChatID: "chat-recent", CreationTime: recent},
			{ChatID: "chat-old", CreationTime: old},
		},
	}
	PopulateSidebarBuckets(&group, now)
	if len(group.PreviewChats) != 1 || group.PreviewChats[0].ChatID != "chat-recent" {
		t.Fatalf("expected recent chat preview, got %#v", group.PreviewChats)
	}
	if len(group.OlderChats) != 1 || group.OlderChats[0].ChatID != "chat-old" {
		t.Fatalf("expected old chat in older bucket, got %#v", group.OlderChats)
	}
	if group.DefaultCollapsed {
		t.Fatal("expected recent group to stay expanded by default")
	}

	oldOnly := SidebarProjectGroup{Chats: []SidebarChatRow{
		{ChatID: "chat-1", CreationTime: old},
		{ChatID: "chat-2", CreationTime: old - 1},
		{ChatID: "chat-3", CreationTime: old - 2},
		{ChatID: "chat-4", CreationTime: old - 3},
		{ChatID: "chat-5", CreationTime: old - 4},
		{ChatID: "chat-6", CreationTime: old - 5},
	}}
	PopulateSidebarBuckets(&oldOnly, now)
	if len(oldOnly.PreviewChats) != 5 || len(oldOnly.OlderChats) != 1 {
		t.Fatalf("expected 5 fallback previews and 1 older chat, got previews=%d older=%d", len(oldOnly.PreviewChats), len(oldOnly.OlderChats))
	}
	if !oldOnly.DefaultCollapsed {
		t.Fatal("expected old-only group to collapse by default")
	}
}

func TestDeriveSidebarDataTracksAssistantActivityTimestamp(t *testing.T) {
	opened, _ := events.NewAt(events.TypeProjectOpened, 100, map[string]any{
		"projectId": "project-1",
		"localPath": "/tmp/project",
		"title":     "project",
	})
	created, _ := events.NewAt(events.TypeChatCreated, 200, map[string]any{
		"chatId":    "chat-1",
		"projectId": "project-1",
		"title":     "chat",
	})
	userPrompt, _ := events.NewAt(events.TypeMessageAppended, 300, map[string]any{
		"chatId": "chat-1",
		"entry": map[string]any{
			"kind":      "user_prompt",
			"content":   "سلام",
			"createdAt": int64(300),
		},
	})
	assistantText, _ := events.NewAt(events.TypeMessageAppended, 350, map[string]any{
		"chatId": "chat-1",
		"entry": map[string]any{
			"kind":      "assistant_text",
			"text":      "پاسخ تازه",
			"createdAt": int64(400),
		},
	})

	sidebar := DeriveSidebarData(Replay([]events.Event{opened, created, userPrompt, assistantText}))
	chat := sidebar.ProjectGroups[0].Chats[0]
	if chat.LastMessageAt == nil || *chat.LastMessageAt != 400 {
		t.Fatalf("expected assistant activity timestamp 400, got %#v", chat.LastMessageAt)
	}
}

func TestDeriveSidebarDataUsesRestoredCheckpointActivityTimestamp(t *testing.T) {
	opened, _ := events.NewAt(events.TypeProjectOpened, 100, map[string]any{
		"projectId": "project-1",
		"localPath": "/tmp/project",
		"title":     "project",
	})
	created, _ := events.NewAt(events.TypeChatCreated, 200, map[string]any{
		"chatId":    "chat-1",
		"projectId": "project-1",
		"title":     "chat",
	})
	restored, _ := events.NewAt(events.TypeChatRestoredToCheckpoint, 500, map[string]any{
		"chatId": "chat-1",
		"messages": []TranscriptEntry{
			{"kind": "user_prompt", "createdAt": int64(300), "content": "سلام"},
			{"kind": "assistant_text", "createdAt": int64(400), "text": "پاسخ تازه"},
		},
	})

	sidebar := DeriveSidebarData(Replay([]events.Event{opened, created, restored}))
	chat := sidebar.ProjectGroups[0].Chats[0]
	if chat.LastMessageAt == nil || *chat.LastMessageAt != 500 {
		t.Fatalf("expected restored checkpoint to sort by the restore activity timestamp 500, got %#v", chat.LastMessageAt)
	}
}

func TestDeriveChatSnapshotIncludesProviders(t *testing.T) {
	provider := "claude"
	planMode := true
	sessionToken := "session-1"
	state := EmptyState()
	state.ProjectsByID["project-1"] = ProjectRecord{
		ID:        "project-1",
		LocalPath: "/tmp/project",
		Title:     "Project",
		CreatedAt: 1,
		UpdatedAt: 1,
	}
	state.ProjectIDsByPath["/tmp/project"] = "project-1"
	state.ChatsByID["chat-1"] = ChatRecord{
		ID:              "chat-1",
		ProjectID:       "project-1",
		Title:           "Chat",
		CreatedAt:       1,
		UpdatedAt:       1,
		Provider:        &provider,
		PlanMode:        true,
		SessionToken:    &sessionToken,
		LastTurnOutcome: nil,
	}
	state.QueuedMessagesByChatID["chat-1"] = []QueuedChatMessage{{
		ID:          "queued-1",
		Content:     "follow up",
		Attachments: []ChatAttachment{},
		CreatedAt:   2,
		Provider:    &provider,
		Model:       "claude-sonnet-4-6",
		PlanMode:    &planMode,
	}}

	chat := DeriveChatSnapshot(
		state,
		map[string]AbolqasemStatus{},
		map[string]bool{},
		"chat-1",
		ChatTranscriptSnapshot{
			Messages: []TranscriptEntry{},
			History: ChatHistorySnapshot{
				HasOlder:    false,
				OlderCursor: nil,
				RecentLimit: 200,
			},
		},
	)

	if chat == nil {
		t.Fatal("expected chat snapshot")
	}
	if chat.Runtime.Provider == nil || *chat.Runtime.Provider != "claude" {
		t.Fatalf("expected claude provider, got %#v", chat.Runtime.Provider)
	}
	if len(chat.QueuedMessages) != 1 || chat.QueuedMessages[0].Content != "follow up" {
		t.Fatalf("unexpected queued messages: %#v", chat.QueuedMessages)
	}
	if chat.QueuedMessages[0].Attachments == nil {
		t.Fatal("expected queued message attachments to serialize as an empty array")
	}
	if chat.History.RecentLimit != 200 {
		t.Fatalf("expected recent limit 200, got %d", chat.History.RecentLimit)
	}
	if len(chat.AvailableProviders) <= 1 {
		t.Fatalf("expected multiple providers, got %#v", chat.AvailableProviders)
	}
	var codexModels []string
	for _, provider := range chat.AvailableProviders {
		if provider.ID != "codex" {
			continue
		}
		for _, model := range provider.Models {
			codexModels = append(codexModels, model.ID)
		}
	}
	var expected []string
	for _, provider := range catalog.ServerProviders() {
		if provider.ID != "codex" {
			continue
		}
		for _, model := range provider.Models {
			expected = append(expected, model.ID)
		}
	}
	if len(codexModels) != len(expected) {
		t.Fatalf("expected codex models %#v, got %#v", expected, codexModels)
	}
	for index := range expected {
		if codexModels[index] != expected[index] {
			t.Fatalf("expected codex models %#v, got %#v", expected, codexModels)
		}
	}
}

func TestDeriveLocalProjectsSnapshotPrefersSavedProject(t *testing.T) {
	state := EmptyState()
	state.ProjectsByID["project-1"] = ProjectRecord{
		ID:        "project-1",
		LocalPath: "/tmp/project",
		Title:     "Saved Project",
		CreatedAt: 10,
		UpdatedAt: 20,
	}
	state.ChatsByID["chat-1"] = ChatRecord{
		ID:        "chat-1",
		ProjectID: "project-1",
		Title:     "Chat",
		CreatedAt: 30,
		UpdatedAt: 40,
	}

	snapshot := DeriveLocalProjectsSnapshot(
		state,
		[]DiscoveredProject{{
			LocalPath:  "/tmp/project",
			Title:      "Discovered Project",
			ModifiedAt: 5,
		}},
		"machine",
		"linux",
	)

	if snapshot.Machine.ID != "local" || snapshot.Machine.DisplayName != "machine" || snapshot.Machine.Platform != "linux" {
		t.Fatalf("unexpected machine: %#v", snapshot.Machine)
	}
	if len(snapshot.Projects) != 1 {
		t.Fatalf("expected one project, got %#v", snapshot.Projects)
	}
	project := snapshot.Projects[0]
	if project.Title != "Saved Project" {
		t.Fatalf("expected saved title, got %q", project.Title)
	}
	if project.Source != "saved" {
		t.Fatalf("expected saved source, got %q", project.Source)
	}
	if project.ChatCount != 1 {
		t.Fatalf("expected chat count 1, got %d", project.ChatCount)
	}
	if project.LastOpenedAt != 40 {
		t.Fatalf("expected last opened at 40, got %d", project.LastOpenedAt)
	}
}
