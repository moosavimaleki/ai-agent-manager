package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"abolqasem/internal/state"
	"abolqasem/internal/workspace/events"
	"abolqasem/internal/workspace/legacyimport"
	"abolqasem/internal/workspace/protocol"
	"abolqasem/internal/workspace/readmodels"

	"github.com/gorilla/websocket"
)

func TestWorkspaceNativeHistoryCacheUsesStatAndDoesNotExposeCachedPayload(t *testing.T) {
	path := filepath.Join(t.TempDir(), "rollout.jsonl")
	if err := os.WriteFile(path, []byte("first"), 0o644); err != nil {
		t.Fatal(err)
	}
	meta := state.SessionMeta{Agent: "codex", SessionID: "session-1", TranscriptPath: path}
	key, modifiedAt, size, cacheable := workspaceNativeHistoryCacheFingerprint(meta, 20, "")
	if !cacheable {
		t.Fatal("expected regular native transcript to be cacheable")
	}
	workspaceNativeHistoryCacheStore(key, modifiedAt, size, map[string]any{
		"messages": []readmodels.TranscriptEntry{{"_id": "message-1", "text": "first"}},
	})
	page, ok := workspaceNativeHistoryCacheLookup(key, modifiedAt, size)
	if !ok {
		t.Fatal("expected native transcript cache hit")
	}
	page["messages"].([]readmodels.TranscriptEntry)[0]["text"] = "mutated by caller"
	freshPage, ok := workspaceNativeHistoryCacheLookup(key, modifiedAt, size)
	if !ok || freshPage["messages"].([]readmodels.TranscriptEntry)[0]["text"] != "first" {
		t.Fatalf("cache payload was mutated by caller: %#v", freshPage)
	}

	if err := os.WriteFile(path, []byte("file changed and grew"), 0o644); err != nil {
		t.Fatal(err)
	}
	_, nextModifiedAt, nextSize, cacheable := workspaceNativeHistoryCacheFingerprint(meta, 20, "")
	if !cacheable || (nextModifiedAt == modifiedAt && nextSize == size) {
		t.Fatalf("expected changed transcript fingerprint, got modified=%d size=%d", nextModifiedAt, nextSize)
	}
	if _, ok := workspaceNativeHistoryCacheLookup(key, nextModifiedAt, nextSize); ok {
		t.Fatal("expected changed native transcript to miss cache")
	}
}

func TestWorkspaceChatRefreshEndpointInvalidatesNativeTranscriptCache(t *testing.T) {
	withWorkspaceComposerStore(t)

	nativePath := filepath.Join(t.TempDir(), "rollout.jsonl")
	if err := os.WriteFile(nativePath, []byte("native transcript"), 0o644); err != nil {
		t.Fatal(err)
	}
	project, err := workspaceOpenProject(t.TempDir(), "Project")
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

	meta, ok, err := workspaceNativeTranscriptMetaForChat(chat.ID)
	if err != nil || !ok {
		t.Fatalf("expected transcript metadata, ok=%v err=%v", ok, err)
	}
	key, modifiedAt, size, cacheable := workspaceNativeHistoryCacheFingerprint(meta, 20, "")
	if !cacheable {
		t.Fatal("expected native transcript to be cacheable")
	}
	workspaceNativeHistoryCacheStore(key, modifiedAt, size, map[string]any{"messages": []readmodels.TranscriptEntry{}})

	request := httptest.NewRequest(http.MethodPost, "/api/chats/"+chat.ID+"/refresh", nil)
	response := httptest.NewRecorder()
	handleAPIChatRefresh(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("expected refresh endpoint to return 200, got %d: %s", response.Code, response.Body.String())
	}
	if _, ok := workspaceNativeHistoryCacheLookup(key, modifiedAt, size); ok {
		t.Fatal("expected an explicit chat refresh to invalidate cached transcript")
	}
}

func TestWorkspaceCommandRoutingHandlesSystemPing(t *testing.T) {
	conn := newTestWorkspaceConnection(nil)

	response := conn.handle(protocol.ClientEnvelope{
		V:       protocol.ProtocolVersion,
		Type:    protocol.EnvelopeCommand,
		ID:      "cmd-1",
		Command: mustWorkspaceRawCommand(t, map[string]any{"type": protocol.CommandSystemPing}),
	})

	if response == nil || response.Type != protocol.EnvelopeAck || response.ID != "cmd-1" {
		t.Fatalf("unexpected response: %#v", response)
	}
	result, ok := response.Result.(map[string]any)
	if !ok || result["ok"] != true {
		t.Fatalf("unexpected ping result: %#v", response.Result)
	}
}

func TestWorkspaceCommandReceiptCacheReturnsTheFirstDeliveryACK(t *testing.T) {
	cache := newWorkspaceCommandReceiptCache(2)
	want := protocol.AckEnvelope("send-1", map[string]any{"chatId": "chat-1"})
	calls := 0
	first := cache.Do("send-1", func() protocol.ServerEnvelope {
		calls++
		return want
	})
	second := cache.Do("send-1", func() protocol.ServerEnvelope {
		calls++
		return protocol.ErrorEnvelope("send-1", "duplicate delivery")
	})

	if calls != 1 {
		t.Fatalf("expected one delivery, got %d", calls)
	}
	if first.Type != protocol.EnvelopeAck || second.Type != protocol.EnvelopeAck || second.ID != "send-1" {
		t.Fatalf("expected cached delivery ACK, got first=%#v second=%#v", first, second)
	}
	result, ok := second.Result.(map[string]any)
	if !ok || result["chatId"] != "chat-1" {
		t.Fatalf("unexpected cached result: %#v", second.Result)
	}
}

func TestWorkspaceCommandReceiptCacheSerializesConcurrentReplay(t *testing.T) {
	cache := newWorkspaceCommandReceiptCache(2)
	entered := make(chan struct{}, 2)
	release := make(chan struct{})
	results := make(chan protocol.ServerEnvelope, 2)
	deliver := func() protocol.ServerEnvelope {
		entered <- struct{}{}
		<-release
		return protocol.AckEnvelope("send-1", map[string]any{"ok": true})
	}

	go func() { results <- cache.Do("send-1", deliver) }()
	go func() { results <- cache.Do("send-1", deliver) }()
	<-entered
	select {
	case <-entered:
		close(release)
		t.Fatal("duplicate replay executed while the first delivery was in flight")
	case <-time.After(20 * time.Millisecond):
	}
	close(release)
	for range 2 {
		if response := <-results; response.Type != protocol.EnvelopeAck {
			t.Fatalf("unexpected replay response: %#v", response)
		}
	}
}

func TestWorkspaceCommandRoutingExplainsUnknownCommandRecovery(t *testing.T) {
	conn := newTestWorkspaceConnection(nil)
	response := conn.handle(protocol.ClientEnvelope{
		V:       protocol.ProtocolVersion,
		Type:    protocol.EnvelopeCommand,
		ID:      "unknown-command",
		Command: mustWorkspaceRawCommand(t, map[string]any{"type": "future.command"}),
	})
	if response == nil || response.Type != protocol.EnvelopeError || !strings.Contains(response.Message, "Reload the page") {
		t.Fatalf("expected actionable version-mismatch error, got %#v", response)
	}
}

func TestWorkspaceCommandRoutingCreatesProjectAndChat(t *testing.T) {
	withWorkspaceComposerStore(t)
	conn := newTestWorkspaceConnection(nil)
	projectDir := t.TempDir()

	projectResponse := conn.handle(protocol.ClientEnvelope{
		V:    protocol.ProtocolVersion,
		Type: protocol.EnvelopeCommand,
		ID:   "project-open",
		Command: mustWorkspaceRawCommand(t, map[string]any{
			"type":      protocol.CommandProjectOpen,
			"localPath": projectDir,
			"title":     "Project",
		}),
	})
	if projectResponse == nil || projectResponse.Type != protocol.EnvelopeAck {
		t.Fatalf("unexpected project response: %#v", projectResponse)
	}
	projectResult, ok := projectResponse.Result.(map[string]any)
	if !ok {
		t.Fatalf("unexpected project result: %#v", projectResponse.Result)
	}
	projectID, ok := projectResult["projectId"].(string)
	if !ok || projectID == "" {
		t.Fatalf("expected project id in result, got %#v", projectResult)
	}

	chatResponse := conn.handle(protocol.ClientEnvelope{
		V:    protocol.ProtocolVersion,
		Type: protocol.EnvelopeCommand,
		ID:   "chat-create",
		Command: mustWorkspaceRawCommand(t, map[string]any{
			"type":      protocol.CommandChatCreate,
			"projectId": projectID,
		}),
	})
	if chatResponse == nil || chatResponse.Type != protocol.EnvelopeAck {
		t.Fatalf("unexpected chat response: %#v", chatResponse)
	}
	chatResult, ok := chatResponse.Result.(map[string]any)
	if !ok {
		t.Fatalf("unexpected chat result: %#v", chatResponse.Result)
	}
	chatID, ok := chatResult["chatId"].(string)
	if !ok || chatID == "" {
		t.Fatalf("expected chat id in result, got %#v", chatResult)
	}
}

func TestWorkspaceCommandRoutingPersistsProjectGroupOrder(t *testing.T) {
	withWorkspaceComposerStore(t)
	conn := newTestWorkspaceConnection(nil)
	firstID := mustCreateWorkspaceProject(t, conn, t.TempDir())
	secondID := mustCreateWorkspaceProject(t, conn, t.TempDir())

	response := conn.handle(protocol.ClientEnvelope{
		V:    protocol.ProtocolVersion,
		Type: protocol.EnvelopeCommand,
		ID:   "sidebar-reorder",
		Command: mustWorkspaceRawCommand(t, map[string]any{
			"type":       protocol.CommandSidebarReorderProjectGroups,
			"projectIds": []string{secondID, firstID},
		}),
	})
	if response == nil || response.Type != protocol.EnvelopeAck {
		t.Fatalf("unexpected reorder response: %#v", response)
	}

	sidebar := workspaceSidebarSnapshot().(readmodels.SidebarData)
	if len(sidebar.ProjectGroups) != 2 || sidebar.ProjectGroups[0].GroupKey != secondID || sidebar.ProjectGroups[1].GroupKey != firstID {
		t.Fatalf("expected persisted order %q, %q; got %#v", secondID, firstID, sidebar.ProjectGroups)
	}

	invalid := conn.handle(protocol.ClientEnvelope{
		V:    protocol.ProtocolVersion,
		Type: protocol.EnvelopeCommand,
		ID:   "sidebar-reorder-invalid",
		Command: mustWorkspaceRawCommand(t, map[string]any{
			"type":       protocol.CommandSidebarReorderProjectGroups,
			"projectIds": []string{firstID, firstID},
		}),
	})
	if invalid == nil || invalid.Type != protocol.EnvelopeError {
		t.Fatalf("expected invalid order to be rejected, got %#v", invalid)
	}
}

func TestWorkspaceCommandRoutingSendsStoredChatWhenLegacyAliasAlsoExists(t *testing.T) {
	withWorkspaceComposerStore(t)

	meta := state.SessionMeta{
		Key:       "codex:shared-send",
		Agent:     "codex",
		SessionID: "shared-send",
	}
	withLegacyState(t, &state.AppState{Sessions: map[string]state.SessionMeta{meta.Key: meta}})
	imported := legacyimport.ImportSession(meta, nil, legacyimport.ImportOptions{})

	conn := newTestWorkspaceConnection(nil)
	projectID := mustCreateWorkspaceProject(t, conn, t.TempDir())
	if err := appendWorkspaceStoreEvent(workspaceStore(), events.StreamChats, events.TypeChatCreated, 100, map[string]any{
		"chatId":    imported.Chat.ID,
		"projectId": projectID,
		"title":     "Stored Chat",
	}); err != nil {
		t.Fatalf("append chat event failed: %v", err)
	}

	response := conn.handle(protocol.ClientEnvelope{
		V:    protocol.ProtocolVersion,
		Type: protocol.EnvelopeCommand,
		ID:   "chat-send",
		Command: mustWorkspaceRawCommand(t, map[string]any{
			"type":    protocol.CommandChatSend,
			"chatId":  imported.Chat.ID,
			"content": "hello",
		}),
	})

	assertWorkspaceAck(t, response, "chat-send")
}

func TestWorkspaceMaterializeImportedChatIfNeededPrefersStoredChat(t *testing.T) {
	withWorkspaceComposerStore(t)

	meta := state.SessionMeta{
		Key:       "codex:shared-materialize",
		Agent:     "codex",
		SessionID: "shared-materialize",
	}
	withLegacyState(t, &state.AppState{Sessions: map[string]state.SessionMeta{meta.Key: meta}})
	imported := legacyimport.ImportSession(meta, nil, legacyimport.ImportOptions{})

	conn := newTestWorkspaceConnection(nil)
	projectID := mustCreateWorkspaceProject(t, conn, t.TempDir())
	if err := appendWorkspaceStoreEvent(workspaceStore(), events.StreamChats, events.TypeChatCreated, 100, map[string]any{
		"chatId":    imported.Chat.ID,
		"projectId": projectID,
		"title":     "Stored Chat",
	}); err != nil {
		t.Fatalf("append chat event failed: %v", err)
	}

	chatID, err := workspaceMaterializeImportedChatIfNeeded(imported.Chat.ID)
	if err != nil {
		t.Fatalf("workspaceMaterializeImportedChatIfNeeded returned error: %v", err)
	}
	if chatID != imported.Chat.ID {
		t.Fatalf("expected stored chat id %q, got %q", imported.Chat.ID, chatID)
	}
}

func TestWorkspaceCommandRoutingHandlesProjectAndChatMutations(t *testing.T) {
	withWorkspaceComposerStore(t)
	conn := newTestWorkspaceConnection(nil)
	projectDir := t.TempDir()

	projectID := mustCreateWorkspaceProject(t, conn, projectDir)
	assertWorkspaceAck(t, conn.handle(protocol.ClientEnvelope{
		V:    protocol.ProtocolVersion,
		Type: protocol.EnvelopeCommand,
		ID:   "project-rename",
		Command: mustWorkspaceRawCommand(t, map[string]any{
			"type":      protocol.CommandProjectRename,
			"projectId": projectID,
			"title":     "Sidebar Name",
		}),
	}), "project-rename")

	chatID := mustCreateWorkspaceChat(t, conn, projectID)
	assertWorkspaceAck(t, conn.handle(protocol.ClientEnvelope{
		V:    protocol.ProtocolVersion,
		Type: protocol.EnvelopeCommand,
		ID:   "chat-rename",
		Command: mustWorkspaceRawCommand(t, map[string]any{
			"type":   protocol.CommandChatRename,
			"chatId": chatID,
			"title":  "Renamed Chat",
		}),
	}), "chat-rename")
	forkResponse := conn.handle(protocol.ClientEnvelope{
		V:       protocol.ProtocolVersion,
		Type:    protocol.EnvelopeCommand,
		ID:      "chat-fork",
		Command: mustWorkspaceRawCommand(t, map[string]any{"type": protocol.CommandChatFork, "chatId": chatID}),
	})
	assertWorkspaceAck(t, forkResponse, "chat-fork")
	forkResult, ok := forkResponse.Result.(map[string]any)
	if !ok || forkResult["chatId"] == "" {
		t.Fatalf("expected fork chat id, got %#v", forkResponse.Result)
	}
	assertWorkspaceAck(t, conn.handle(protocol.ClientEnvelope{
		V:       protocol.ProtocolVersion,
		Type:    protocol.EnvelopeCommand,
		ID:      "chat-archive",
		Command: mustWorkspaceRawCommand(t, map[string]any{"type": protocol.CommandChatArchive, "chatId": chatID}),
	}), "chat-archive")
	assertWorkspaceAck(t, conn.handle(protocol.ClientEnvelope{
		V:       protocol.ProtocolVersion,
		Type:    protocol.EnvelopeCommand,
		ID:      "chat-unarchive",
		Command: mustWorkspaceRawCommand(t, map[string]any{"type": protocol.CommandChatUnarchive, "chatId": chatID}),
	}), "chat-unarchive")
	assertWorkspaceAck(t, conn.handle(protocol.ClientEnvelope{
		V:       protocol.ProtocolVersion,
		Type:    protocol.EnvelopeCommand,
		ID:      "chat-delete",
		Command: mustWorkspaceRawCommand(t, map[string]any{"type": protocol.CommandChatDelete, "chatId": chatID}),
	}), "chat-delete")

	state, err := workspaceStore().LoadState()
	if err != nil {
		t.Fatalf("LoadState returned error: %v", err)
	}
	project := state.ProjectsByID[projectID]
	if project.SidebarTitle == nil || *project.SidebarTitle != "Sidebar Name" {
		t.Fatalf("expected renamed project sidebar title, got %#v", project)
	}
	chat := state.ChatsByID[chatID]
	if chat.Title != "Renamed Chat" || chat.DeletedAt == 0 {
		t.Fatalf("expected renamed deleted chat, got %#v", chat)
	}
}

func TestWorkspaceCommandRoutingHandlesGitAndHistoryCommands(t *testing.T) {
	withWorkspaceComposerStore(t)
	conn := newTestWorkspaceConnection(nil)
	projectID := mustCreateWorkspaceProject(t, conn, t.TempDir())
	chatID := mustCreateWorkspaceChat(t, conn, projectID)

	gitResponse := conn.handle(protocol.ClientEnvelope{
		V:       protocol.ProtocolVersion,
		Type:    protocol.EnvelopeCommand,
		ID:      "git-init",
		Command: mustWorkspaceRawCommand(t, map[string]any{"type": protocol.CommandChatInitGit, "chatId": chatID}),
	})
	assertWorkspaceAck(t, gitResponse, "git-init")

	messageResponse := conn.handle(protocol.ClientEnvelope{
		V:    protocol.ProtocolVersion,
		Type: protocol.EnvelopeCommand,
		ID:   "commit-message",
		Command: mustWorkspaceRawCommand(t, map[string]any{
			"type":   protocol.CommandChatGenerateCommitMessage,
			"chatId": chatID,
			"paths":  []string{"internal/server/workspace_ws.go"},
		}),
	})
	assertWorkspaceAck(t, messageResponse, "commit-message")
	result, ok := messageResponse.Result.(map[string]any)
	if !ok || result["subject"] == "" {
		t.Fatalf("expected generated commit message, got %#v", messageResponse.Result)
	}

	historyResponse := conn.handle(protocol.ClientEnvelope{
		V:    protocol.ProtocolVersion,
		Type: protocol.EnvelopeCommand,
		ID:   "history",
		Command: mustWorkspaceRawCommand(t, map[string]any{
			"type":         protocol.CommandChatLoadHistory,
			"chatId":       chatID,
			"beforeCursor": "",
			"limit":        25,
		}),
	})
	assertWorkspaceAck(t, historyResponse, "history")
}

func TestWorkspaceRefreshDiffsCommandRunsAsync(t *testing.T) {
	conn := newTestWorkspaceConnection(nil)
	for _, commandType := range []string{protocol.CommandChatRefresh, protocol.CommandChatRefreshDiffs} {
		raw := mustWorkspaceRawCommand(t, map[string]any{
			"type":   commandType,
			"chatId": "chat-1",
		})
		if !conn.shouldHandleCommandAsync(raw) {
			t.Fatalf("expected %s to be handled asynchronously", commandType)
		}
	}
}

func TestWorkspaceChatRefreshOnlySendsSnapshotToRequestingTab(t *testing.T) {
	withWorkspaceComposerStore(t)
	ownerWrites := 0
	otherTabWrites := 0
	owner := newTestWorkspaceConnection(func(envelope protocol.ServerEnvelope) error {
		if envelope.Type == protocol.EnvelopeSnapshot && envelope.Snapshot != nil && envelope.Snapshot.Type == protocol.SnapshotChat {
			ownerWrites++
		}
		return nil
	})
	otherTab := newTestWorkspaceConnection(func(envelope protocol.ServerEnvelope) error {
		if envelope.Type == protocol.EnvelopeSnapshot && envelope.Snapshot != nil && envelope.Snapshot.Type == protocol.SnapshotChat {
			otherTabWrites++
		}
		return nil
	})
	projectID := mustCreateWorkspaceProject(t, owner, t.TempDir())
	chatID := mustCreateWorkspaceChat(t, owner, projectID)
	recentLimit := 50
	topic := protocol.SubscriptionTopic{Type: protocol.TopicChat, ChatID: chatID, RecentLimit: &recentLimit}
	owner.subscribe("owner-chat", chatSubscription+chatID, topic)
	otherTab.subscribe("other-chat", chatSubscription+chatID, topic)
	t.Cleanup(owner.close)
	t.Cleanup(otherTab.close)

	response := owner.handleCommand(protocol.ClientEnvelope{
		V:    protocol.ProtocolVersion,
		Type: protocol.EnvelopeCommand,
		ID:   "refresh-owner",
		Command: mustWorkspaceRawCommand(t, map[string]any{
			"type":   protocol.CommandChatRefresh,
			"chatId": chatID,
		}),
	})
	assertWorkspaceAck(t, response, "refresh-owner")
	if ownerWrites != 1 {
		t.Fatalf("expected one refreshed snapshot for requesting tab, got %d", ownerWrites)
	}
	if otherTabWrites != 0 {
		t.Fatalf("expected polling refresh not to fan out to another tab, got %d snapshots", otherTabWrites)
	}

	secondResponse := owner.handleCommand(protocol.ClientEnvelope{
		V:    protocol.ProtocolVersion,
		Type: protocol.EnvelopeCommand,
		ID:   "refresh-owner-again",
		Command: mustWorkspaceRawCommand(t, map[string]any{
			"type":   protocol.CommandChatRefresh,
			"chatId": chatID,
		}),
	})
	assertWorkspaceAck(t, secondResponse, "refresh-owner-again")
	if ownerWrites != 1 {
		t.Fatalf("expected repeated polling inside the throttle window to reuse current state, got %d snapshots", ownerWrites)
	}
}

func TestWorkspaceRefreshDiffsBroadcastsSnapshotEvenWhenUnchanged(t *testing.T) {
	withWorkspaceComposerStore(t)
	withWorkspaceConnectionRegistry(t)
	originalCache := workspaceProjectGitSnapshots
	workspaceProjectGitSnapshots = newWorkspaceProjectGitSnapshotCache()
	t.Cleanup(func() { workspaceProjectGitSnapshots = originalCache })

	envelopes := []protocol.ServerEnvelope{}
	conn := newTestWorkspaceConnection(func(envelope protocol.ServerEnvelope) error {
		envelopes = append(envelopes, envelope)
		return nil
	})
	workspaceConnections.add(conn)
	t.Cleanup(func() { workspaceConnections.remove(conn) })

	projectDir := t.TempDir()
	runGit(t, projectDir, "init")
	if err := os.WriteFile(filepath.Join(projectDir, "app.txt"), []byte("one\n"), 0o644); err != nil {
		t.Fatalf("write app.txt failed: %v", err)
	}
	projectID := mustCreateWorkspaceProject(t, conn, projectDir)
	chatID := mustCreateWorkspaceChat(t, conn, projectID)

	subscribeResponse := conn.handle(protocol.ClientEnvelope{
		V:     protocol.ProtocolVersion,
		Type:  protocol.EnvelopeSubscribe,
		ID:    "sub-project-git",
		Topic: &protocol.SubscriptionTopic{Type: protocol.TopicProjectGit, ProjectID: projectID},
	})
	if subscribeResponse == nil || subscribeResponse.Snapshot == nil || subscribeResponse.Snapshot.Type != protocol.SnapshotProjectGit {
		t.Fatalf("unexpected project git subscribe response: %#v", subscribeResponse)
	}

	rawCommand := mustWorkspaceRawCommand(t, map[string]any{
		"type":   protocol.CommandChatRefreshDiffs,
		"chatId": chatID,
	})
	firstResponse := conn.handleCommand(protocol.ClientEnvelope{
		V:       protocol.ProtocolVersion,
		Type:    protocol.EnvelopeCommand,
		ID:      "refresh-1",
		Command: rawCommand,
	})
	assertWorkspaceAck(t, firstResponse, "refresh-1")
	secondResponse := conn.handleCommand(protocol.ClientEnvelope{
		V:       protocol.ProtocolVersion,
		Type:    protocol.EnvelopeCommand,
		ID:      "refresh-2",
		Command: rawCommand,
	})
	assertWorkspaceAck(t, secondResponse, "refresh-2")
	secondResult, ok := secondResponse.Result.(map[string]any)
	if !ok || secondResult["changed"] != false {
		t.Fatalf("expected second refresh to be unchanged, got %#v", secondResponse.Result)
	}

	snapshotCount := 0
	for _, envelope := range envelopes {
		if envelope.Snapshot != nil && envelope.Snapshot.Type == protocol.SnapshotProjectGit {
			snapshotCount++
		}
	}
	if snapshotCount != 2 {
		t.Fatalf("expected both refresh commands to broadcast project-git snapshots, got %d envelopes=%#v", snapshotCount, envelopes)
	}
}

func TestWorkspaceSubscriptionRegistryBroadcastsOnlyRelatedTopics(t *testing.T) {
	withWorkspaceComposerStore(t)
	withWorkspaceConnectionRegistry(t)

	sidebarEnvelopes := []protocol.ServerEnvelope{}
	updateEnvelopes := []protocol.ServerEnvelope{}
	sidebarConn := newTestWorkspaceConnection(func(envelope protocol.ServerEnvelope) error {
		sidebarEnvelopes = append(sidebarEnvelopes, envelope)
		return nil
	})
	updateConn := newTestWorkspaceConnection(func(envelope protocol.ServerEnvelope) error {
		updateEnvelopes = append(updateEnvelopes, envelope)
		return nil
	})

	sidebarResponse := sidebarConn.handle(protocol.ClientEnvelope{
		V:     protocol.ProtocolVersion,
		Type:  protocol.EnvelopeSubscribe,
		ID:    "sub-sidebar",
		Topic: &protocol.SubscriptionTopic{Type: protocol.TopicSidebar},
	})
	if sidebarResponse == nil || sidebarResponse.Snapshot == nil || sidebarResponse.Snapshot.Type != protocol.SnapshotSidebar {
		t.Fatalf("unexpected sidebar subscribe response: %#v", sidebarResponse)
	}
	updateResponse := updateConn.handle(protocol.ClientEnvelope{
		V:     protocol.ProtocolVersion,
		Type:  protocol.EnvelopeSubscribe,
		ID:    "sub-update",
		Topic: &protocol.SubscriptionTopic{Type: protocol.TopicUpdate},
	})
	if updateResponse == nil || updateResponse.Snapshot == nil || updateResponse.Snapshot.Type != protocol.SnapshotUpdate {
		t.Fatalf("unexpected update subscribe response: %#v", updateResponse)
	}

	workspaceConnections.broadcast("")
	if len(sidebarEnvelopes) != 1 || sidebarEnvelopes[0].Snapshot == nil || sidebarEnvelopes[0].Snapshot.Type != protocol.SnapshotSidebar {
		t.Fatalf("expected sidebar broadcast only for sidebar subscriber, got %#v", sidebarEnvelopes)
	}
	if len(updateEnvelopes) != 0 {
		t.Fatalf("update subscriber received unrelated sidebar/local-project broadcast: %#v", updateEnvelopes)
	}

	workspaceConnections.broadcastUpdate(map[string]any{"status": "idle"})
	if len(updateEnvelopes) != 1 || updateEnvelopes[0].Snapshot == nil || updateEnvelopes[0].Snapshot.Type != protocol.SnapshotUpdate {
		t.Fatalf("expected update broadcast for update subscriber, got %#v", updateEnvelopes)
	}
	if len(sidebarEnvelopes) != 1 {
		t.Fatalf("sidebar subscriber received unrelated update broadcast: %#v", sidebarEnvelopes)
	}
}

func TestWorkspaceConnectionRegistryBroadcastsToEachIndependentTab(t *testing.T) {
	registry := newWorkspaceConnectionRegistry()
	const tabCount = 48
	received := make([][]protocol.ServerEnvelope, tabCount)

	for index := range tabCount {
		index := index
		conn := &workspaceConnection{
			writeFn: func(envelope protocol.ServerEnvelope) error {
				received[index] = append(received[index], envelope)
				return nil
			},
			subscriptions: map[string]workspaceSubscription{},
		}
		registry.add(conn)
		registry.subscribe(sidebarSubscription, "tab-"+strconv.Itoa(index), conn)
	}

	registry.broadcastTopic(sidebarSubscription, protocol.SnapshotSidebar, map[string]any{"revision": 1})
	for index, envelopes := range received {
		if len(envelopes) != 1 {
			t.Fatalf("tab %d received %d snapshots, want one", index, len(envelopes))
		}
		if envelopes[0].ID != "tab-"+strconv.Itoa(index) {
			t.Fatalf("tab %d received a snapshot for %q", index, envelopes[0].ID)
		}
	}
}

func TestWorkspaceConnectionBackpressureClosesOnlyTheSlowTab(t *testing.T) {
	conn := &workspaceConnection{
		outbound: make(chan protocol.ServerEnvelope, 1),
		done:     make(chan struct{}),
	}
	conn.outbound <- protocol.AckEnvelope("already-queued", nil)

	started := time.Now()
	err := conn.write(protocol.AckEnvelope("must-not-block", nil))
	if err != errWorkspaceConnectionBackpressure {
		t.Fatalf("expected backpressure error, got %v", err)
	}
	if elapsed := time.Since(started); elapsed > 100*time.Millisecond {
		t.Fatalf("slow tab blocked the caller for %s", elapsed)
	}
	select {
	case <-conn.done:
	default:
		t.Fatal("expected only the slow tab connection to close")
	}
}

func TestWorkspaceWebSocketSupportsIndependentBrowserTabs(t *testing.T) {
	withWorkspaceConnectionRegistry(t)
	server := httptest.NewServer(http.HandlerFunc(handleWorkspaceWS))
	defer server.Close()

	wsURL := "ws" + strings.TrimPrefix(server.URL, "http")
	const tabCount = 16
	connections := make([]*websocket.Conn, 0, tabCount)
	for index := range tabCount {
		conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
		if err != nil {
			t.Fatalf("tab %d could not connect: %v", index, err)
		}
		connections = append(connections, conn)
	}
	defer func() {
		for _, conn := range connections {
			_ = conn.Close()
		}
	}()

	for index, conn := range connections {
		id := "tab-" + strconv.Itoa(index)
		if err := conn.WriteJSON(protocol.ClientEnvelope{
			V:       protocol.ProtocolVersion,
			Type:    protocol.EnvelopeCommand,
			ID:      id,
			Command: mustWorkspaceRawCommand(t, map[string]any{"type": protocol.CommandSystemPing}),
		}); err != nil {
			t.Fatalf("tab %d could not send ping: %v", index, err)
		}
	}
	for index, conn := range connections {
		_ = conn.SetReadDeadline(time.Now().Add(time.Second))
		var response protocol.ServerEnvelope
		if err := conn.ReadJSON(&response); err != nil {
			t.Fatalf("tab %d did not receive an ACK: %v", index, err)
		}
		id := "tab-" + strconv.Itoa(index)
		if response.Type != protocol.EnvelopeAck || response.ID != id {
			t.Fatalf("tab %d received %#v, want ACK %q", index, response, id)
		}
	}
}

func TestWorkspaceSubscriptionUnsubscribeStopsBroadcast(t *testing.T) {
	withWorkspaceComposerStore(t)
	withWorkspaceConnectionRegistry(t)

	envelopes := []protocol.ServerEnvelope{}
	conn := newTestWorkspaceConnection(func(envelope protocol.ServerEnvelope) error {
		envelopes = append(envelopes, envelope)
		return nil
	})
	conn.handle(protocol.ClientEnvelope{
		V:     protocol.ProtocolVersion,
		Type:  protocol.EnvelopeSubscribe,
		ID:    "sub-sidebar",
		Topic: &protocol.SubscriptionTopic{Type: protocol.TopicSidebar},
	})
	conn.handle(protocol.ClientEnvelope{
		V:    protocol.ProtocolVersion,
		Type: protocol.EnvelopeUnsubscribe,
		ID:   "sub-sidebar",
	})

	workspaceConnections.broadcast("")
	if len(envelopes) != 0 {
		t.Fatalf("unsubscribed connection received broadcast: %#v", envelopes)
	}
}

func TestWorkspaceAppSettingsSubscriptionBroadcastsToSubscribers(t *testing.T) {
	withWorkspaceComposerStore(t)
	withWorkspaceConnectionRegistry(t)

	envelopes := []protocol.ServerEnvelope{}
	conn := newTestWorkspaceConnection(func(envelope protocol.ServerEnvelope) error {
		envelopes = append(envelopes, envelope)
		return nil
	})
	subscribeResponse := conn.handle(protocol.ClientEnvelope{
		V:     protocol.ProtocolVersion,
		Type:  protocol.EnvelopeSubscribe,
		ID:    "sub-app-settings",
		Topic: &protocol.SubscriptionTopic{Type: protocol.TopicAppSettings},
	})
	if subscribeResponse == nil || subscribeResponse.Snapshot == nil || subscribeResponse.Snapshot.Type != protocol.SnapshotAppSettings {
		t.Fatalf("unexpected app-settings subscribe response: %#v", subscribeResponse)
	}

	workspaceConnections.broadcastAppSettings(map[string]any{"locale": "fa"})
	if len(envelopes) != 1 || envelopes[0].Snapshot == nil || envelopes[0].Snapshot.Type != protocol.SnapshotAppSettings {
		t.Fatalf("expected app-settings broadcast, got %#v", envelopes)
	}
}

func TestWorkspaceGlobalEventSubscriptionUsesExistingWebSocket(t *testing.T) {
	withWorkspaceConnectionRegistry(t)

	envelopes := []protocol.ServerEnvelope{}
	conn := newTestWorkspaceConnection(func(envelope protocol.ServerEnvelope) error {
		envelopes = append(envelopes, envelope)
		return nil
	})
	subscribeResponse := conn.handle(protocol.ClientEnvelope{
		V:     protocol.ProtocolVersion,
		Type:  protocol.EnvelopeSubscribe,
		ID:    "sub-global-events",
		Topic: &protocol.SubscriptionTopic{Type: protocol.TopicGlobalEvents},
	})
	if subscribeResponse == nil || subscribeResponse.Snapshot == nil || subscribeResponse.Snapshot.Type != protocol.SnapshotGlobalEvents {
		t.Fatalf("unexpected global-events subscribe response: %#v", subscribeResponse)
	}

	event := SSEEvent{Source: "hook", EventKey: "hook-1", HookEventName: "config-updated"}
	workspaceConnections.broadcastGlobalEvent(event)

	if len(envelopes) != 1 {
		t.Fatalf("expected one global event envelope, got %#v", envelopes)
	}
	envelope := envelopes[0]
	if envelope.Type != protocol.EnvelopeEvent || envelope.ID != "sub-global-events" {
		t.Fatalf("unexpected global event envelope: %#v", envelope)
	}
	got, ok := envelope.Event.(SSEEvent)
	if !ok || got.Source != "hook" || got.EventKey != "hook-1" {
		t.Fatalf("unexpected global event payload: %#v", envelope.Event)
	}
}

func newTestWorkspaceConnection(writeFn func(protocol.ServerEnvelope) error) *workspaceConnection {
	return &workspaceConnection{
		hub:           newWorkspaceTerminalHub(),
		writeFn:       writeFn,
		subscriptions: map[string]workspaceSubscription{},
	}
}

func mustCreateWorkspaceProject(t *testing.T, conn *workspaceConnection, localPath string) string {
	t.Helper()
	response := conn.handle(protocol.ClientEnvelope{
		V:    protocol.ProtocolVersion,
		Type: protocol.EnvelopeCommand,
		ID:   "project-create",
		Command: mustWorkspaceRawCommand(t, map[string]any{
			"type":      protocol.CommandProjectCreate,
			"localPath": localPath,
			"title":     "Project",
		}),
	})
	if response == nil || response.Type != protocol.EnvelopeAck {
		t.Fatalf("unexpected project create response: %#v", response)
	}
	result, ok := response.Result.(map[string]any)
	if !ok {
		t.Fatalf("unexpected project create result: %#v", response.Result)
	}
	projectID, ok := result["projectId"].(string)
	if !ok || projectID == "" {
		t.Fatalf("expected project id in result, got %#v", result)
	}
	return projectID
}

func mustCreateWorkspaceChat(t *testing.T, conn *workspaceConnection, projectID string) string {
	t.Helper()
	response := conn.handle(protocol.ClientEnvelope{
		V:    protocol.ProtocolVersion,
		Type: protocol.EnvelopeCommand,
		ID:   "chat-create",
		Command: mustWorkspaceRawCommand(t, map[string]any{
			"type":      protocol.CommandChatCreate,
			"projectId": projectID,
		}),
	})
	if response == nil || response.Type != protocol.EnvelopeAck {
		t.Fatalf("unexpected chat create response: %#v", response)
	}
	result, ok := response.Result.(map[string]any)
	if !ok {
		t.Fatalf("unexpected chat create result: %#v", response.Result)
	}
	chatID, ok := result["chatId"].(string)
	if !ok || chatID == "" {
		t.Fatalf("expected chat id in result, got %#v", result)
	}
	return chatID
}

func assertWorkspaceAck(t *testing.T, response *protocol.ServerEnvelope, id string) {
	t.Helper()
	if response == nil || response.Type != protocol.EnvelopeAck || response.ID != id {
		t.Fatalf("unexpected ack response for %s: %#v", id, response)
	}
}

func withWorkspaceConnectionRegistry(t *testing.T) {
	t.Helper()
	previous := workspaceConnections
	workspaceConnections = newWorkspaceConnectionRegistry()
	t.Cleanup(func() {
		workspaceConnections = previous
	})
}

func mustWorkspaceRawCommand(t *testing.T, value map[string]any) json.RawMessage {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("json.Marshal returned error: %v", err)
	}
	return data
}
