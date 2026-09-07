package server

import (
	"context"
	"encoding/json"
	"testing"

	"abolqasem/internal/state"
	"abolqasem/internal/workspace/agent"
	"abolqasem/internal/workspace/events"
	"abolqasem/internal/workspace/eventstore"
	"abolqasem/internal/workspace/readmodels"
	"abolqasem/internal/workspace/transcript"
)

func withWorkspaceComposerStore(t *testing.T) {
	t.Helper()
	dir := t.TempDir()
	previousDataDir := workspaceDataDir
	previousCoordinator := workspaceCoordinator
	previousCoordinatorDir := workspaceCoordinatorDir
	previousTurnStarterFactory := workspaceTurnStarterFactory
	previousLegacyState := workspaceLoadLegacyState
	workspaceDataDir = func() string { return dir }
	workspaceCoordinator = nil
	workspaceCoordinatorDir = ""
	workspaceTurnStarterFactory = func(*eventstore.Store) agent.TurnStarter {
		return agent.TurnStarterFunc(func(context.Context, agent.TurnRequest) (agent.Turn, error) {
			return &workspaceComposerTestTurn{}, nil
		})
	}
	t.Setenv("ABOLQASEM_TMUX_CODEX_COMMAND", "true")
	t.Setenv("ABOLQASEM_TMUX_CLAUDE_COMMAND", "true")
	t.Setenv("ABOLQASEM_TMUX_GEMINI_COMMAND", "true")
	workspaceLoadLegacyState = func() (*state.AppState, error) {
		return &state.AppState{Sessions: map[string]state.SessionMeta{}}, nil
	}
	t.Cleanup(func() {
		workspaceDataDir = previousDataDir
		workspaceCoordinator = previousCoordinator
		workspaceCoordinatorDir = previousCoordinatorDir
		workspaceTurnStarterFactory = previousTurnStarterFactory
		workspaceLoadLegacyState = previousLegacyState
	})
}

type workspaceComposerTestTurn struct{}

func (workspaceComposerTestTurn) Cancel() error {
	return nil
}

func (workspaceComposerTestTurn) RespondTool(context.Context, agent.ToolResponse) error {
	return nil
}

func TestWorkspaceComposerCreatesChatAndSendsPrompt(t *testing.T) {
	withWorkspaceComposerStore(t)

	project, err := workspaceOpenProject("/tmp/project", "Project")
	if err != nil {
		t.Fatalf("workspaceOpenProject returned error: %v", err)
	}
	chat, err := workspaceCreateChat(project.ID)
	if err != nil {
		t.Fatalf("workspaceCreateChat returned error: %v", err)
	}
	if chat.TmuxSession != "" {
		t.Fatalf("new app-server chat must not create a tmux session, got %q", chat.TmuxSession)
	}
	result, err := workspaceAgentCoordinator().Send(context.Background(), agent.SendCommand{
		ChatID:   chat.ID,
		Content:  "hello",
		Provider: "codex",
		Model:    "gpt-5.5",
		PlanMode: true,
	})
	if err != nil {
		t.Fatalf("Send returned error: %v", err)
	}
	if result.ChatID != chat.ID || result.Queued {
		t.Fatalf("unexpected send result: %#v", result)
	}

	snapshot := workspaceChatSnapshot(chat.ID, 10).(*readmodels.ChatSnapshot)
	if snapshot.Runtime.Status != readmodels.StatusStarting && snapshot.Runtime.Status != readmodels.StatusRunning {
		t.Fatalf("expected active status, got %q", snapshot.Runtime.Status)
	}
	if snapshot.Runtime.Provider == nil || *snapshot.Runtime.Provider != "codex" {
		t.Fatalf("expected codex provider, got %#v", snapshot.Runtime.Provider)
	}
	if snapshot.Runtime.TmuxSession != "" {
		t.Fatalf("snapshot must not expose an active tmux runtime, got %q", snapshot.Runtime.TmuxSession)
	}
	if len(snapshot.Messages) != 0 {
		t.Fatalf("expected tmux chat to avoid eventstore transcript, got %#v", snapshot.Messages)
	}
	messageEvents, err := workspaceStore().Replay(events.StreamMessages)
	if err != nil {
		t.Fatalf("Replay messages returned error: %v", err)
	}
	if len(messageEvents) != 0 {
		t.Fatalf("expected tmux chat send to avoid message events, got %#v", messageEvents)
	}
}

func TestWorkspaceSetChatPlanModePersistsRuntimeState(t *testing.T) {
	withWorkspaceComposerStore(t)

	project, err := workspaceOpenProject("/tmp/plan-mode-project", "Plan mode")
	if err != nil {
		t.Fatal(err)
	}
	chat, err := workspaceCreateChat(project.ID)
	if err != nil {
		t.Fatal(err)
	}
	raw := json.RawMessage(`{"chatId":"` + chat.ID + `","planMode":true}`)
	chatID, err := workspaceSetChatPlanMode(raw)
	if err != nil {
		t.Fatalf("workspaceSetChatPlanMode returned error: %v", err)
	}
	if chatID != chat.ID {
		t.Fatalf("expected chat %q, got %q", chat.ID, chatID)
	}
	snapshot := workspaceChatSnapshot(chat.ID, 1).(*readmodels.ChatSnapshot)
	if !snapshot.Runtime.PlanMode {
		t.Fatal("expected persisted runtime plan mode")
	}
}

func TestWorkspaceComposerQueuesAndCancels(t *testing.T) {
	withWorkspaceComposerStore(t)

	project, err := workspaceOpenProject("/tmp/project", "Project")
	if err != nil {
		t.Fatalf("workspaceOpenProject returned error: %v", err)
	}
	chat, err := workspaceCreateChat(project.ID)
	if err != nil {
		t.Fatalf("workspaceCreateChat returned error: %v", err)
	}
	if _, err := workspaceAgentCoordinator().Send(context.Background(), agent.SendCommand{ChatID: chat.ID, Content: "first"}); err != nil {
		t.Fatalf("Send returned error: %v", err)
	}
	queued, err := workspaceAgentCoordinator().Send(context.Background(), agent.SendCommand{ChatID: chat.ID, Content: "second"})
	if err != nil {
		t.Fatalf("queued Send returned error: %v", err)
	}
	if !queued.Queued || queued.QueuedMessageID == "" {
		t.Fatalf("expected queued send result, got %#v", queued)
	}
	snapshot := workspaceChatSnapshot(chat.ID, 10).(*readmodels.ChatSnapshot)
	if len(snapshot.QueuedMessages) != 1 || snapshot.QueuedMessages[0].Content != "second" {
		t.Fatalf("expected queued message in snapshot, got %#v", snapshot.QueuedMessages)
	}
	if snapshot.QueuedMessages[0].Attachments == nil {
		t.Fatal("expected queued message attachments to serialize as an empty array")
	}

	if err := workspaceAgentCoordinator().Cancel(chat.ID); err != nil {
		t.Fatalf("Cancel returned error: %v", err)
	}
	snapshot = workspaceChatSnapshot(chat.ID, 10).(*readmodels.ChatSnapshot)
	if snapshot.Runtime.Status == readmodels.StatusRunning {
		t.Fatal("expected chat to stop running after cancel")
	}
}

func TestWorkspaceComposerDeduplicatesQueuedDeliveryRequest(t *testing.T) {
	withWorkspaceComposerStore(t)

	project, err := workspaceOpenProject("/tmp/queued-delivery", "Queued delivery")
	if err != nil {
		t.Fatal(err)
	}
	chat, err := workspaceCreateChat(project.ID)
	if err != nil {
		t.Fatal(err)
	}
	store := &workspaceEventStore{store: workspaceStore()}
	message := agent.QueueMessageInput{RequestID: "delivery-1", Content: "send once"}
	first, err := store.EnqueueMessage(chat.ID, message)
	if err != nil {
		t.Fatal(err)
	}
	second, err := store.EnqueueMessage(chat.ID, message)
	if err != nil {
		t.Fatal(err)
	}

	if first.ID != "queued-delivery-1" || second.ID != first.ID {
		t.Fatalf("expected stable queued message ID, got first=%q second=%q", first.ID, second.ID)
	}
	if queued := store.GetQueuedMessages(chat.ID); len(queued) != 1 {
		t.Fatalf("expected one persisted queued message, got %#v", queued)
	}
}

func TestWorkspaceRuntimeEventsUpdateSnapshots(t *testing.T) {
	withWorkspaceComposerStore(t)

	project, err := workspaceOpenProject("/tmp/project", "Project")
	if err != nil {
		t.Fatalf("workspaceOpenProject returned error: %v", err)
	}
	chatID := "chat-runtime-events-legacy"
	appendWorkspaceEvent(t, workspaceStore(), events.StreamChats, events.TypeChatCreated, 200, map[string]any{
		"chatId":    chatID,
		"projectId": project.ID,
		"title":     "Legacy runtime events",
	})
	if _, err := workspaceAgentCoordinator().Send(context.Background(), agent.SendCommand{ChatID: chatID, Content: "first"}); err != nil {
		t.Fatalf("Send returned error: %v", err)
	}
	if err := workspaceAppendAssistantText(chatID, "working"); err != nil {
		t.Fatalf("workspaceAppendAssistantText returned error: %v", err)
	}
	if err := workspaceAgentCoordinator().SetPendingTool(chatID, agent.PendingToolRequest{
		ToolUseID: "tool-1",
		ToolKind:  "ask_user_question",
		ToolName:  "AskUserQuestion",
		Input: map[string]any{
			"questions": []any{},
		},
	}); err != nil {
		t.Fatalf("SetPendingTool returned error: %v", err)
	}

	snapshot := workspaceChatSnapshot(chatID, 20).(*readmodels.ChatSnapshot)
	if snapshot.Runtime.Status != readmodels.StatusWaitingForUser {
		t.Fatalf("expected waiting_for_user status, got %q", snapshot.Runtime.Status)
	}
	if len(snapshot.Messages) != 1 || transcript.Kind(snapshot.Messages[0]) != transcript.KindToolCall {
		t.Fatalf("expected one live pending-tool card without persistent message storage, got %#v", snapshot.Messages)
	}

	if err := workspaceAgentCoordinator().RespondTool(context.Background(), agent.ToolResponseCommand{
		ChatID:    chatID,
		ToolUseID: "tool-1",
		Result:    map[string]any{"answers": map[string]any{}},
	}); err != nil {
		t.Fatalf("RespondTool returned error: %v", err)
	}
	snapshot = workspaceChatSnapshot(chatID, 20).(*readmodels.ChatSnapshot)
	if snapshot.Runtime.Status != readmodels.StatusRunning {
		t.Fatalf("expected running status after tool response, got %q", snapshot.Runtime.Status)
	}
}

func TestWorkspaceSidebarReflectsRuntimeStatus(t *testing.T) {
	withWorkspaceComposerStore(t)

	project, err := workspaceOpenProject("/tmp/project", "Project")
	if err != nil {
		t.Fatalf("workspaceOpenProject returned error: %v", err)
	}
	chat, err := workspaceCreateChat(project.ID)
	if err != nil {
		t.Fatalf("workspaceCreateChat returned error: %v", err)
	}
	if _, err := workspaceAgentCoordinator().Send(context.Background(), agent.SendCommand{ChatID: chat.ID, Content: "first"}); err != nil {
		t.Fatalf("Send returned error: %v", err)
	}
	sidebar := workspaceSidebarSnapshot().(readmodels.SidebarData)
	if got := sidebar.ProjectGroups[0].Chats[0].Status; got != string(readmodels.StatusStarting) && got != string(readmodels.StatusRunning) {
		t.Fatalf("expected active sidebar status, got %q", got)
	}
	if err := workspaceAgentCoordinator().SetPendingTool(chat.ID, agent.PendingToolRequest{ToolUseID: "tool-1", ToolKind: "exit_plan_mode"}); err != nil {
		t.Fatalf("SetPendingTool returned error: %v", err)
	}
	sidebar = workspaceSidebarSnapshot().(readmodels.SidebarData)
	if got := sidebar.ProjectGroups[0].Chats[0].Status; got != string(readmodels.StatusWaitingForUser) {
		t.Fatalf("expected waiting sidebar status, got %q", got)
	}
	if err := workspaceAgentCoordinator().Cancel(chat.ID); err != nil {
		t.Fatalf("Cancel returned error: %v", err)
	}
	if err := (&workspaceEventStore{store: workspaceStore()}).RecordTurnFailed(chat.ID, "failed"); err != nil {
		t.Fatalf("RecordTurnFailed returned error: %v", err)
	}
	sidebar = workspaceSidebarSnapshot().(readmodels.SidebarData)
	if got := sidebar.ProjectGroups[0].Chats[0].Status; got != string(readmodels.StatusFailed) {
		t.Fatalf("expected failed sidebar status, got %q", got)
	}
}

func hasTranscriptKind(messages []readmodels.TranscriptEntry, kind string) bool {
	for _, message := range messages {
		if transcript.Kind(message) == kind {
			return true
		}
	}
	return false
}
