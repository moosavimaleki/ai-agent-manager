package server

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"abolqasem/internal/parser"
	"abolqasem/internal/state"
	"abolqasem/internal/workspace/agent"
	"abolqasem/internal/workspace/events"
	"abolqasem/internal/workspace/eventstore"
	"abolqasem/internal/workspace/readmodels"
	"abolqasem/internal/workspace/transcript"
)

func withWorkspaceSnapshotStore(t *testing.T) *eventstore.Store {
	t.Helper()
	dir := t.TempDir()
	previous := workspaceDataDir
	previousLegacyState := workspaceLoadLegacyState
	workspaceDataDir = func() string { return dir }
	workspaceLoadLegacyState = func() (*state.AppState, error) {
		return &state.AppState{Sessions: map[string]state.SessionMeta{}}, nil
	}
	t.Cleanup(func() {
		workspaceDataDir = previous
		workspaceLoadLegacyState = previousLegacyState
	})
	return eventstore.New(dir)
}

func TestWorkspaceBoundTranscriptSnapshotPayloadKeepsNewestEntriesWithinBudget(t *testing.T) {
	entries := []readmodels.TranscriptEntry{
		{"_id": "old", "text": strings.Repeat("a", 120)},
		{"_id": "middle", "text": strings.Repeat("b", 120)},
		{"_id": "new", "text": strings.Repeat("c", 40)},
	}

	bounded, omitted := workspaceBoundTranscriptSnapshotPayload(entries, 200)
	if omitted != 2 {
		t.Fatalf("expected two omitted entries, got %d", omitted)
	}
	if len(bounded) != 1 || bounded[0]["_id"] != "new" {
		t.Fatalf("expected newest entry only, got %#v", bounded)
	}
}

func TestWorkspaceBoundTranscriptSnapshotPayloadRetainsNewestOversizedEntry(t *testing.T) {
	entries := []readmodels.TranscriptEntry{
		{"_id": "old", "text": "small"},
		{"_id": "new", "text": strings.Repeat("x", 1024)},
	}

	bounded, omitted := workspaceBoundTranscriptSnapshotPayload(entries, 100)
	if omitted != 1 {
		t.Fatalf("expected old entry to be omitted, got %d", omitted)
	}
	if len(bounded) != 1 || bounded[0]["_id"] != "new" {
		t.Fatalf("expected newest oversized entry to remain visible, got %#v", bounded)
	}
}

func TestWorkspaceSidebarAndLocalProjectsSnapshotsComeFromEventStore(t *testing.T) {
	store := withWorkspaceSnapshotStore(t)
	appendWorkspaceEvent(t, store, events.StreamProjects, events.TypeProjectOpened, 100, map[string]any{
		"projectId": "project-1",
		"localPath": "/tmp/project",
		"title":     "Project",
	})
	appendWorkspaceEvent(t, store, events.StreamChats, events.TypeChatCreated, 200, map[string]any{
		"chatId":    "chat-1",
		"projectId": "project-1",
		"title":     "Chat",
	})

	sidebar := workspaceSidebarSnapshot().(readmodels.SidebarData)
	if len(sidebar.ProjectGroups) != 1 {
		t.Fatalf("expected one project group, got %#v", sidebar.ProjectGroups)
	}
	if sidebar.ProjectGroups[0].Chats[0].ChatID != "chat-1" {
		t.Fatalf("expected chat-1 in sidebar, got %#v", sidebar.ProjectGroups[0].Chats)
	}

	localProjects := workspaceLocalProjectsSnapshot().(readmodels.LocalProjectsSnapshot)
	if len(localProjects.Projects) != 1 || localProjects.Projects[0].LocalPath != "/tmp/project" {
		t.Fatalf("expected local project snapshot from event store, got %#v", localProjects.Projects)
	}
}

func TestWorkspaceChatSnapshotIncludesRecentTranscript(t *testing.T) {
	store := withWorkspaceSnapshotStore(t)
	appendWorkspaceEvent(t, store, events.StreamProjects, events.TypeProjectOpened, 100, map[string]any{
		"projectId": "project-1",
		"localPath": "/tmp/project",
		"title":     "Project",
	})
	appendWorkspaceEvent(t, store, events.StreamChats, events.TypeChatCreated, 200, map[string]any{
		"chatId":    "chat-1",
		"projectId": "project-1",
		"title":     "Chat",
	})
	appendWorkspaceEvent(t, store, events.StreamMessages, events.TypeMessageAppended, 300, map[string]any{
		"chatId": "chat-1",
		"entry": readmodels.TranscriptEntry{
			"_id":       "m1",
			"kind":      transcript.KindUserPrompt,
			"createdAt": float64(300),
			"content":   "hello",
		},
	})
	appendWorkspaceEvent(t, store, events.StreamMessages, events.TypeMessageAppended, 400, map[string]any{
		"chatId": "chat-1",
		"entry": readmodels.TranscriptEntry{
			"_id":       "m2",
			"kind":      transcript.KindAssistantText,
			"createdAt": float64(400),
			"text":      "hi",
		},
	})

	snapshot := workspaceChatSnapshot("chat-1", 1).(*readmodels.ChatSnapshot)
	if snapshot.Runtime.ChatID != "chat-1" {
		t.Fatalf("expected chat runtime, got %#v", snapshot.Runtime)
	}
	if len(snapshot.Messages) != 1 || snapshot.Messages[0]["_id"] != "m2" {
		t.Fatalf("expected only newest transcript entry, got %#v", snapshot.Messages)
	}
	if !snapshot.History.HasOlder || snapshot.History.OlderCursor == nil || *snapshot.History.OlderCursor != "m1" {
		t.Fatalf("expected older history cursor m1, got %#v", snapshot.History)
	}
}

func TestWorkspaceChatSnapshotSkipsMessageReplayForEmptyTmuxChat(t *testing.T) {
	store := withWorkspaceSnapshotStore(t)
	appendWorkspaceEvent(t, store, events.StreamProjects, events.TypeProjectOpened, 100, map[string]any{
		"projectId": "project-1",
		"localPath": "/tmp/project",
		"title":     "Project",
	})
	appendWorkspaceEvent(t, store, events.StreamChats, events.TypeChatCreated, 200, map[string]any{
		"chatId":      "chat-1",
		"projectId":   "project-1",
		"title":       "Chat",
		"tmuxSession": "abolqasem-chat-1",
	})
	if err := os.WriteFile(filepath.Join(workspaceDataDir(), "messages.jsonl"), []byte("{bad json\n"), 0o644); err != nil {
		t.Fatalf("WriteFile returned error: %v", err)
	}

	snapshot, ok := workspaceChatSnapshot("chat-1", 200).(*readmodels.ChatSnapshot)
	if !ok || snapshot == nil {
		t.Fatalf("expected tmux chat snapshot despite malformed messages stream, got %#v", snapshot)
	}
	if snapshot.Runtime.TmuxSession != "abolqasem-chat-1" {
		t.Fatalf("expected tmux runtime metadata, got %#v", snapshot.Runtime)
	}
}

func TestWorkspaceChatSnapshotPrefersNativeTranscriptForTmuxChat(t *testing.T) {
	store := withWorkspaceSnapshotStore(t)
	nativePath := filepath.Join(t.TempDir(), "native.jsonl")
	body := `{"type":"event_msg","payload":{"type":"user_message","message":"native prompt"}}` + "\n" +
		`{"type":"event_msg","payload":{"type":"agent_message","message":"native answer"}}` + "\n"
	if err := os.WriteFile(nativePath, []byte(body), 0o644); err != nil {
		t.Fatalf("WriteFile returned error: %v", err)
	}
	appendWorkspaceEvent(t, store, events.StreamProjects, events.TypeProjectOpened, 100, map[string]any{
		"projectId": "project-1",
		"localPath": "/tmp/project",
		"title":     "Project",
	})
	appendWorkspaceEvent(t, store, events.StreamChats, events.TypeChatCreated, 200, map[string]any{
		"chatId":               "chat-1",
		"projectId":            "project-1",
		"title":                "Chat",
		"provider":             "codex",
		"tmuxSession":          "abolqasem-chat-1",
		"nativeSessionId":      "native-session",
		"nativeTranscriptPath": nativePath,
	})

	snapshot := workspaceChatSnapshot("chat-1", 10).(*readmodels.ChatSnapshot)
	if len(snapshot.Messages) != 2 {
		t.Fatalf("expected native transcript messages, got %#v", snapshot.Messages)
	}
	if id, _ := snapshot.Messages[0]["_id"].(string); strings.HasPrefix(id, "tmux-capture-") {
		t.Fatalf("expected native transcript entry, got tmux capture %#v", snapshot.Messages[0])
	}
	if transcript.Kind(snapshot.Messages[0]) != transcript.KindUserPrompt || transcript.Kind(snapshot.Messages[1]) != transcript.KindAssistantText {
		t.Fatalf("expected native user/assistant messages, got %#v", snapshot.Messages)
	}
}

func TestWorkspaceChatSnapshotTrimsRedundantToolResultDebugRaw(t *testing.T) {
	store := withWorkspaceSnapshotStore(t)
	appendWorkspaceEvent(t, store, events.StreamProjects, events.TypeProjectOpened, 100, map[string]any{
		"projectId": "project-1",
		"localPath": "/tmp/project",
		"title":     "Project",
	})
	appendWorkspaceEvent(t, store, events.StreamChats, events.TypeChatCreated, 200, map[string]any{
		"chatId":    "chat-1",
		"projectId": "project-1",
		"title":     "Chat",
	})
	appendWorkspaceEvent(t, store, events.StreamMessages, events.TypeMessageAppended, 300, map[string]any{
		"chatId": "chat-1",
		"entry": readmodels.TranscriptEntry{
			"_id":       "tool-call",
			"kind":      transcript.KindToolCall,
			"createdAt": float64(300),
			"tool": map[string]any{
				"toolId":   "call-1",
				"toolKind": "bash",
				"toolName": "exec_command",
			},
		},
	})
	appendWorkspaceEvent(t, store, events.StreamMessages, events.TypeMessageAppended, 301, map[string]any{
		"chatId": "chat-1",
		"entry": readmodels.TranscriptEntry{
			"_id":       "tool-result",
			"kind":      transcript.KindToolResult,
			"createdAt": float64(301),
			"toolId":    "call-1",
			"content":   "small display content",
			"debugRaw":  strings.Repeat("large raw payload", 100),
		},
	})

	snapshot := workspaceChatSnapshot("chat-1", 10).(*readmodels.ChatSnapshot)
	if _, ok := snapshot.Messages[1]["debugRaw"]; ok {
		t.Fatalf("expected redundant debugRaw to be trimmed, got %#v", snapshot.Messages[1])
	}
}

func TestWorkspaceChatSnapshotBackfillsLegacySessionToken(t *testing.T) {
	store := withWorkspaceSnapshotStore(t)
	workspaceLoadLegacyState = func() (*state.AppState, error) {
		return &state.AppState{Sessions: map[string]state.SessionMeta{
			"codex:legacy-session-1": {
				Key:         "codex:legacy-session-1",
				Agent:       "codex",
				SessionID:   "legacy-session-1",
				Cwd:         "/tmp/project",
				ProjectName: "Project",
				UpdatedAt:   time.Unix(1700000000, 0),
			},
		}}, nil
	}
	appendWorkspaceEvent(t, store, events.StreamProjects, events.TypeProjectOpened, 100, map[string]any{
		"projectId": "project-1",
		"localPath": "/tmp/project",
		"title":     "Project",
	})
	appendWorkspaceEvent(t, store, events.StreamChats, events.TypeChatCreated, 200, map[string]any{
		"chatId":    "chat-1",
		"projectId": "project-1",
		"title":     "Chat",
	})
	appendWorkspaceEvent(t, store, events.StreamChats, events.TypeChatProviderSet, 210, map[string]any{
		"chatId":   "chat-1",
		"provider": "codex",
	})
	appendWorkspaceEvent(t, store, events.StreamMessages, events.TypeMessageAppended, 300, map[string]any{
		"chatId": "chat-1",
		"entry": readmodels.TranscriptEntry{
			"_id":       "codex-user-legacy-session-1-1",
			"kind":      transcript.KindUserPrompt,
			"createdAt": float64(300),
			"content":   "hello",
		},
	})

	snapshot := workspaceChatSnapshot("chat-1", 10).(*readmodels.ChatSnapshot)
	if snapshot.Runtime.SessionToken == nil || *snapshot.Runtime.SessionToken != "legacy-session-1" {
		t.Fatalf("expected backfilled session token, got %#v", snapshot.Runtime.SessionToken)
	}
}

func appendWorkspaceEvent(t *testing.T, store *eventstore.Store, stream string, eventType string, timestamp int64, data map[string]any) {
	t.Helper()
	event, err := events.NewAt(eventType, timestamp, data)
	if err != nil {
		t.Fatalf("NewAt returned error: %v", err)
	}
	if err := store.Append(stream, event); err != nil {
		t.Fatalf("Append returned error: %v", err)
	}
}

func TestWorkspaceTranscriptEntryRestoresCodexMobileAttachmentsAndPlan(t *testing.T) {
	setTestUploadCacheHome(t)
	user := workspaceTranscriptEntryFromSearchable(parser.SearchableMessage{
		ID: "user-1", Role: "user", Kind: "message",
		Text: "# Files mentioned by the user:\n\n## pasted.txt: /tmp/pasted.txt\n\n## My request for Codex:\n\nInspect this file",
	})
	if user["content"] != "Inspect this file" {
		t.Fatalf("expected request text without attachment protocol, got %#v", user)
	}
	attachments, ok := user["attachments"].([]readmodels.ChatAttachment)
	if !ok || len(attachments) != 1 || attachments[0].DisplayName != "pasted.txt" {
		t.Fatalf("expected attachment card metadata, got %#v", user)
	}

	imageData := []byte("uploaded image bytes")
	uploadedImage, err := saveUploadedFile("project-1", "image.png", "image/png", int64(len(imageData)), bytes.NewReader(imageData))
	if err != nil {
		t.Fatalf("saveUploadedFile returned error: %v", err)
	}
	imagePrompt := workspaceTranscriptEntryFromSearchable(parser.SearchableMessage{
		ID: "user-image", Role: "user", Kind: "message",
		Text: "# Files mentioned by the user:\n\n## image.png: " + uploadedImage.AbsolutePath + "\n\n## My request for Codex:\n\nInspect this image",
	})
	imageAttachments, ok := imagePrompt["attachments"].([]readmodels.ChatAttachment)
	if !ok || len(imageAttachments) != 1 {
		t.Fatalf("expected uploaded image attachment, got %#v", imagePrompt)
	}
	imageAttachment := imageAttachments[0]
	if imageAttachment.Kind != "image" || imageAttachment.MimeType != "image/png" || imageAttachment.Size != int64(len(imageData)) || imageAttachment.ContentURL != uploadedImage.ContentURL {
		t.Fatalf("expected complete uploaded image metadata, got %#v", imageAttachment)
	}

	legacy := workspaceTranscriptEntryFromSearchable(parser.SearchableMessage{
		ID: "user-2", Role: "user", Kind: "message", Text: "Inspect this\n\n[Attached text file: pasted.txt]\n\nvery long body",
	})
	if legacy["content"] != "Inspect this" {
		t.Fatalf("expected legacy pasted body to be hidden, got %#v", legacy)
	}
	legacyAttachments, ok := legacy["attachments"].([]readmodels.ChatAttachment)
	if !ok || len(legacyAttachments) != 1 || legacyAttachments[0].Size != int64(len("very long body")) {
		t.Fatalf("expected collapsed legacy attachment, got %#v", legacy)
	}

	plan := workspaceTranscriptEntryFromSearchable(parser.SearchableMessage{
		ID: "plan-1", Kind: "turn_plan", Fields: map[string]any{
			"turnId": "turn-1", "explanation": "Ship it", "plan": []map[string]string{{"step": "Test", "status": "completed"}},
		},
	})
	if plan["kind"] != transcript.KindTurnPlan || plan["turnId"] != "turn-1" {
		t.Fatalf("expected native plan transcript entry, got %#v", plan)
	}

	proposedPlan := workspaceTranscriptEntryFromSearchable(parser.SearchableMessage{
		ID: "proposed-plan-1", Role: "assistant", Kind: "proposed_plan", Text: "# Plan", Fields: map[string]any{
			"turnId": "turn-1", "plan": "# Plan",
		},
	})
	if proposedPlan["kind"] != transcript.KindProposedPlan || proposedPlan["turnId"] != "turn-1" || proposedPlan["plan"] != "# Plan" {
		t.Fatalf("expected native proposed-plan transcript entry, got %#v", proposedPlan)
	}

	fileChange := workspaceTranscriptEntryFromSearchable(parser.SearchableMessage{
		ID: "change-1", Kind: "file_change", Fields: map[string]any{
			"itemId": "patch-1", "status": "completed",
			"changes": []map[string]any{{"path": "main.go", "kind": "update", "diff": "@@ -1 +1 @@\n-old\n+new"}},
		},
	})
	if fileChange["kind"] != transcript.KindFileChange || fileChange["itemId"] != "patch-1" {
		t.Fatalf("expected native file-change transcript entry, got %#v", fileChange)
	}

	turnError := workspaceTranscriptEntryFromSearchable(parser.SearchableMessage{
		ID: "failure-1", Role: "system", Kind: transcript.KindResult, Text: "Please sign in again", Fields: map[string]any{
			"subtype": "error", "isError": true, "durationMs": float64(4028),
		},
	})
	if turnError["kind"] != transcript.KindResult || turnError["result"] != "Please sign in again" || turnError["isError"] != true {
		t.Fatalf("expected native turn error transcript entry, got %#v", turnError)
	}

	mcpCall := workspaceTranscriptEntryFromSearchable(parser.SearchableMessage{
		ID: "mcp-call-1", Kind: "mcp_tool_call", Fields: map[string]any{
			"toolId": "mcp-call-1", "server": "grafana", "tool": "query_victoriametrics", "input": map[string]any{"expr": "up"},
		},
	})
	if mcpCall["kind"] != transcript.KindToolCall {
		t.Fatalf("expected MCP tool call card, got %#v", mcpCall)
	}
	mcpTool := mcpCall["tool"].(map[string]any)
	if mcpTool["toolKind"] != "mcp_generic" || mcpTool["toolName"] != "mcp__grafana__query_victoriametrics" {
		t.Fatalf("unexpected MCP tool card: %#v", mcpTool)
	}

	mcpResult := workspaceTranscriptEntryFromSearchable(parser.SearchableMessage{
		ID: "mcp-result-1", Kind: "mcp_tool_result", Fields: map[string]any{
			"toolId": "mcp-call-1", "content": map[string]any{"ok": true}, "isError": false,
		},
	})
	if mcpResult["kind"] != transcript.KindToolResult || mcpResult["toolId"] != "mcp-call-1" || mcpResult["isError"] != false {
		t.Fatalf("expected MCP tool result card data, got %#v", mcpResult)
	}
}

func TestWorkspacePendingToolTranscriptEntryPreservesPlanQuestions(t *testing.T) {
	entry := workspacePendingToolTranscriptEntry(&agent.PendingToolSnapshot{
		ToolUseID: "ask-1",
		ToolKind:  "ask_user_question",
		ToolName:  "AskUserQuestion",
		CreatedAt: 123,
		Input: map[string]any{"questions": []map[string]any{{
			"id": "scope", "header": "Scope", "question": "Which scope?",
			"options": []map[string]any{{"label": "Small", "description": "Only the focused file"}},
		}}},
	})
	if entry["_id"] != "pending-tool-ask-1" || entry["kind"] != transcript.KindToolCall || entry["createdAt"] != float64(123) {
		t.Fatalf("unexpected pending tool entry: %#v", entry)
	}
	tool, ok := entry["tool"].(map[string]any)
	if !ok || tool["toolName"] != "AskUserQuestion" || tool["toolId"] != "ask-1" {
		t.Fatalf("expected ask-user-question tool payload, got %#v", entry)
	}
}
