package server

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"abolqasem/internal/state"
	"abolqasem/internal/workspace/events"
	"abolqasem/internal/workspace/readmodels"
	"abolqasem/internal/workspace/transcript"
)

func TestWorkspaceNativeHistoryDoesNotReadStoredMessagesStream(t *testing.T) {
	withWorkspaceComposerStore(t)
	projectDir := t.TempDir()
	nativePath := filepath.Join(t.TempDir(), "native.jsonl")
	body := `{"type":"event_msg","payload":{"type":"user_message","message":"first native prompt"}}` + "\n" +
		`{"type":"event_msg","payload":{"type":"agent_message","message":"first native answer"}}` + "\n" +
		`{"type":"event_msg","payload":{"type":"user_message","message":"second native prompt"}}` + "\n" +
		`{"type":"response_item","payload":{"type":"custom_tool_call","call_id":"call-native","name":"exec","input":"const r = await tools.exec_command({cmd:\"rtk pwd\",workdir:\"/tmp/project\"}); text(r.output);"}}` + "\n" +
		`{"type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"call-native","output":[{"type":"input_text","text":"Script completed\nOutput:\n/tmp/project\n"}]}}` + "\n"
	if err := os.WriteFile(nativePath, []byte(body), 0o644); err != nil {
		t.Fatalf("write native transcript: %v", err)
	}
	project, err := workspaceOpenProject(projectDir, "Project")
	if err != nil {
		t.Fatalf("workspaceOpenProject returned error: %v", err)
	}
	store := &workspaceEventStore{store: workspaceStore()}
	chat, err := store.CreateChat(project.ID)
	if err != nil {
		t.Fatalf("CreateChat returned error: %v", err)
	}
	if err := store.SetChatProvider(chat.ID, "codex"); err != nil {
		t.Fatalf("SetChatProvider returned error: %v", err)
	}
	if err := appendWorkspaceStoreEvent(workspaceStore(), events.StreamChats, events.TypeChatRuntimeSet, time.Now().UnixMilli(), map[string]any{
		"chatId":               chat.ID,
		"nativeSessionId":      "native-session",
		"nativeTranscriptPath": nativePath,
	}); err != nil {
		t.Fatalf("append runtime metadata: %v", err)
	}
	if err := os.WriteFile(filepath.Join(workspaceDataDir(), events.StreamMessages+".jsonl"), []byte("{bad json\n"), 0o644); err != nil {
		t.Fatalf("write bad messages stream: %v", err)
	}

	raw, _ := json.Marshal(map[string]any{"chatId": chat.ID})
	indexSnapshot, err := workspaceReadChatTranscriptIndex(raw)
	if err != nil {
		t.Fatalf("workspaceReadChatTranscriptIndex returned error: %v", err)
	}
	items := indexSnapshot["items"].([]workspaceTranscriptIndexItem)
	if len(items) != 5 || items[0].Preview != "first native prompt" {
		t.Fatalf("unexpected native transcript index: %#v", items)
	}

	history, err := workspaceLoadStoredChatHistory(chat.ID, "", 4)
	if err != nil {
		t.Fatalf("workspaceLoadStoredChatHistory returned error: %v", err)
	}
	messages := history["messages"].([]readmodels.TranscriptEntry)
	if len(messages) != 4 || transcript.Kind(messages[0]) != transcript.KindAssistantText || transcript.Kind(messages[1]) != transcript.KindUserPrompt || transcript.Kind(messages[2]) != transcript.KindCommandExecution || transcript.Kind(messages[3]) != transcript.KindCommandExecution {
		t.Fatalf("unexpected native history page: %#v", messages)
	}
	if messages[2]["command"] != "rtk pwd" || messages[2]["cwd"] != "/tmp/project" || messages[3]["aggregatedOutput"] == "" {
		t.Fatalf("expected native command details and output, got %#v", messages[2:])
	}
	if history["hasOlder"] != true {
		t.Fatalf("expected native history to report older entries, got %#v", history)
	}
	olderCursor, ok := history["olderCursor"].(*string)
	if !ok || olderCursor == nil || *olderCursor != workspaceTranscriptCursor(messages[0]) {
		t.Fatalf("expected exclusive cursor for the first returned native entry, got %#v", history)
	}
	older, err := workspaceLoadStoredChatHistory(chat.ID, *olderCursor, 4)
	if err != nil {
		t.Fatalf("loading the preceding native page returned error: %v", err)
	}
	olderMessages := older["messages"].([]readmodels.TranscriptEntry)
	if len(olderMessages) != 1 || olderMessages[0]["_id"] == messages[0]["_id"] {
		t.Fatalf("expected exactly the native entry before the page boundary, got %#v", older)
	}
	oldestCursor, _ := older["olderCursor"].(*string)
	if older["hasOlder"] != false || oldestCursor != nil {
		t.Fatalf("expected the oldest native page to end pagination, got %#v", older)
	}

	around, err := workspaceLoadStoredChatHistoryAround(chat.ID, items[1].ID, 3)
	if err != nil {
		t.Fatalf("workspaceLoadStoredChatHistoryAround returned error: %v", err)
	}
	aroundMessages := around["messages"].([]readmodels.TranscriptEntry)
	if around["targetFound"] != true || len(aroundMessages) != 3 {
		t.Fatalf("unexpected native history around result: %#v", around)
	}
}

func TestWorkspaceNativeHistoryUsesCanonicalDiscoveredTranscriptForTmuxChat(t *testing.T) {
	withWorkspaceComposerStore(t)
	projectDir := t.TempDir()
	stalePath := filepath.Join(t.TempDir(), "partial.jsonl")
	canonicalPath := filepath.Join(t.TempDir(), "complete.jsonl")
	if err := os.WriteFile(stalePath, []byte(`{"type":"event_msg","payload":{"type":"user_message","message":"partial"}}`+"\n"), 0o644); err != nil {
		t.Fatalf("write partial transcript: %v", err)
	}
	if err := os.WriteFile(canonicalPath, []byte(
		`{"type":"event_msg","payload":{"type":"user_message","message":"first"}}`+"\n"+
			`{"type":"event_msg","payload":{"type":"agent_message","message":"answer"}}`+"\n",
	), 0o644); err != nil {
		t.Fatalf("write complete transcript: %v", err)
	}

	project, err := workspaceOpenProject(projectDir, "Project")
	if err != nil {
		t.Fatalf("workspaceOpenProject returned error: %v", err)
	}
	store := &workspaceEventStore{store: workspaceStore()}
	chat, err := store.CreateChat(project.ID)
	if err != nil {
		t.Fatalf("CreateChat returned error: %v", err)
	}
	if err := appendWorkspaceStoreEvent(workspaceStore(), events.StreamChats, events.TypeChatRuntimeSet, time.Now().UnixMilli(), map[string]any{
		"chatId":               chat.ID,
		"nativeSessionId":      "native-session",
		"nativeTranscriptPath": stalePath,
	}); err != nil {
		t.Fatalf("append runtime metadata: %v", err)
	}

	previousLoad := workspaceLoadLegacyState
	workspaceLoadLegacyState = func() (*state.AppState, error) {
		return &state.AppState{Sessions: map[string]state.SessionMeta{
			"codex:native-session": {
				Key:            "codex:native-session",
				Agent:          "codex",
				SessionID:      "native-session",
				TranscriptPath: canonicalPath,
			},
		}}, nil
	}
	t.Cleanup(func() { workspaceLoadLegacyState = previousLoad })

	history, err := workspaceLoadStoredChatHistory(chat.ID, "", 10)
	if err != nil {
		t.Fatalf("workspaceLoadStoredChatHistory returned error: %v", err)
	}
	messages := history["messages"].([]readmodels.TranscriptEntry)
	if len(messages) != 2 || messages[0]["content"] != "first" || messages[1]["text"] != "answer" {
		t.Fatalf("expected canonical transcript history, got %#v", messages)
	}
}
