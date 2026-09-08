package server

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"abolqasem/internal/providers/catalog"
	"abolqasem/internal/state"
	"abolqasem/internal/workspace/agent"
	"abolqasem/internal/workspace/events"
	"abolqasem/internal/workspace/eventstore"
	"abolqasem/internal/workspace/protocol"
	"abolqasem/internal/workspace/readmodels"
)

const (
	sidebarSubscription               = "__sidebar__"
	localProjectsSubscription         = "__local_projects__"
	updateSubscription                = "__update__"
	appSettingsSubscription           = "__app_settings__"
	globalEventsSubscription          = "__global_events__"
	terminalSubscription              = "terminal:"
	chatSubscription                  = "chat:"
	projectGitSubscription            = "project_git:"
	workspaceChatBroadcastMinInterval = 150 * time.Millisecond
)

var (
	workspaceCoordinatorMu      sync.Mutex
	workspaceCoordinator        *agent.Coordinator
	workspaceCoordinatorDir     string
	workspaceConnections        = newWorkspaceConnectionRegistry()
	workspaceTurnStarterFactory = func(store *eventstore.Store) agent.TurnStarter {
		return newWorkspaceTurnStarter(store)
	}
)

type workspaceEventStore struct {
	store *eventstore.Store
}

type workspaceConnectionRegistry struct {
	mu                sync.Mutex
	connections       map[*workspaceConnection]struct{}
	subscribers       map[string]map[*workspaceConnection]map[string]struct{}
	broadcastPending  map[string]bool
	broadcastRunning  map[string]bool
	lastChatBroadcast map[string]time.Time
	chatStatuses      map[string]readmodels.AbolqasemStatus
}

func newWorkspaceConnectionRegistry() *workspaceConnectionRegistry {
	return &workspaceConnectionRegistry{
		connections:       map[*workspaceConnection]struct{}{},
		subscribers:       map[string]map[*workspaceConnection]map[string]struct{}{},
		broadcastPending:  map[string]bool{},
		broadcastRunning:  map[string]bool{},
		lastChatBroadcast: map[string]time.Time{},
		chatStatuses:      map[string]readmodels.AbolqasemStatus{},
	}
}

func (r *workspaceConnectionRegistry) scheduleBroadcast(chatID string) {
	// A streaming Codex turn can emit many deltas per second. Broadcasting the
	// sidebar and local-project snapshots for every one of those deltas blocks
	// the single websocket writer behind large payloads. In turn, chat.send ACKs
	// time out in the browser even though Codex already accepted the prompt.
	// Stream only the affected chat; the sidebar needs a refresh only when the
	// chat status changes (starting/running/idle/etc.).
	status := readmodels.StatusIdle
	if active, ok := workspaceAgentCoordinator().ActiveStatuses()[chatID]; ok {
		status = active
	}
	r.mu.Lock()
	previousStatus, knownStatus := r.chatStatuses[chatID]
	sidebarChanged := !knownStatus || previousStatus != status
	r.chatStatuses[chatID] = status
	r.broadcastPending[chatID] = true
	if r.broadcastRunning[chatID] {
		r.mu.Unlock()
		if sidebarChanged {
			r.broadcastSidebar()
		}
		return
	}
	r.broadcastRunning[chatID] = true
	r.mu.Unlock()

	go func() {
		for {
			r.mu.Lock()
			if !r.broadcastPending[chatID] {
				delete(r.broadcastRunning, chatID)
				r.mu.Unlock()
				return
			}
			if wait := time.Until(r.lastChatBroadcast[chatID].Add(workspaceChatBroadcastMinInterval)); wait > 0 {
				r.mu.Unlock()
				timer := time.NewTimer(wait)
				<-timer.C
				continue
			}
			delete(r.broadcastPending, chatID)
			r.lastChatBroadcast[chatID] = time.Now()
			r.mu.Unlock()
			r.broadcastChat(chatID)
		}
	}()
	if sidebarChanged {
		r.broadcastSidebar()
	}
}

func (r *workspaceConnectionRegistry) add(conn *workspaceConnection) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.connections[conn] = struct{}{}
}

func (r *workspaceConnectionRegistry) remove(conn *workspaceConnection) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.connections, conn)
	for topicKey, topicSubscribers := range r.subscribers {
		delete(topicSubscribers, conn)
		if len(topicSubscribers) == 0 {
			delete(r.subscribers, topicKey)
		}
	}
}

func (r *workspaceConnectionRegistry) subscribe(topicKey string, subscriptionID string, conn *workspaceConnection) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.subscribers[topicKey] == nil {
		r.subscribers[topicKey] = map[*workspaceConnection]map[string]struct{}{}
	}
	if r.subscribers[topicKey][conn] == nil {
		r.subscribers[topicKey][conn] = map[string]struct{}{}
	}
	r.subscribers[topicKey][conn][subscriptionID] = struct{}{}
}

func (r *workspaceConnectionRegistry) unsubscribe(topicKey string, subscriptionID string, conn *workspaceConnection) {
	r.mu.Lock()
	defer r.mu.Unlock()
	topicSubscribers := r.subscribers[topicKey]
	if topicSubscribers == nil {
		return
	}
	subscriptionIDs := topicSubscribers[conn]
	if subscriptionIDs == nil {
		return
	}
	delete(subscriptionIDs, subscriptionID)
	if len(subscriptionIDs) == 0 {
		delete(topicSubscribers, conn)
	}
	if len(topicSubscribers) == 0 {
		delete(r.subscribers, topicKey)
	}
}

func (r *workspaceConnectionRegistry) topicSubscribers(topicKey string) map[*workspaceConnection][]string {
	r.mu.Lock()
	defer r.mu.Unlock()
	topicSubscribers := r.subscribers[topicKey]
	out := make(map[*workspaceConnection][]string, len(topicSubscribers))
	for conn, subscriptionIDs := range topicSubscribers {
		for subscriptionID := range subscriptionIDs {
			out[conn] = append(out[conn], subscriptionID)
		}
	}
	return out
}

func (r *workspaceConnectionRegistry) broadcast(chatID string) {
	r.broadcastSidebar()
	r.broadcastTopic(localProjectsSubscription, protocol.SnapshotLocalProjects, workspaceLocalProjectsSnapshot())
	if chatID != "" {
		r.broadcastChat(chatID)
	}
}

func (r *workspaceConnectionRegistry) broadcastSidebar() {
	workspaceInvalidateSidebarSnapshot()
	r.broadcastTopic(sidebarSubscription, protocol.SnapshotSidebar, workspaceSidebarSnapshot())
}

func (r *workspaceConnectionRegistry) broadcastTopic(topicKey string, snapshotType string, data any) {
	for conn, subscriptionIDs := range r.topicSubscribers(topicKey) {
		for _, subscriptionID := range subscriptionIDs {
			_ = conn.write(protocol.SnapshotEnvelope(subscriptionID, snapshotType, data))
		}
	}
}

func (r *workspaceConnectionRegistry) broadcastChat(chatID string) {
	for conn, subscriptionIDs := range r.topicSubscribers(chatSubscription + chatID) {
		for _, subscriptionID := range subscriptionIDs {
			subscription, ok := conn.subscription(subscriptionID)
			if !ok {
				continue
			}
			_ = conn.write(protocol.SnapshotEnvelope(
				subscriptionID,
				protocol.SnapshotChat,
				workspaceChatSnapshot(chatID, subscriptionRecentLimit(subscription.topic)),
			))
		}
	}
}

func (r *workspaceConnectionRegistry) broadcastKeybindings(snapshot state.KeybindingsSnapshot) {
	r.broadcastTopic(keybindingsSubscription, protocol.SnapshotKeybindings, snapshot)
}

func (r *workspaceConnectionRegistry) broadcastUpdate(snapshot map[string]any) {
	r.broadcastTopic(updateSubscription, protocol.SnapshotUpdate, snapshot)
}

func (r *workspaceConnectionRegistry) broadcastAppSettings(snapshot map[string]any) {
	r.broadcastTopic(appSettingsSubscription, protocol.SnapshotAppSettings, snapshot)
}

// broadcastGlobalEvent delivers a process-wide notification through each
// tab's existing websocket. It deliberately does not use a snapshot: events
// are transient and must not make a newly opened tab replay old alerts.
func (r *workspaceConnectionRegistry) broadcastGlobalEvent(event any) {
	for conn, subscriptionIDs := range r.topicSubscribers(globalEventsSubscription) {
		for _, subscriptionID := range subscriptionIDs {
			_ = conn.write(protocol.EventEnvelope(subscriptionID, event))
		}
	}
}

func (r *workspaceConnectionRegistry) broadcastProjectGit(projectID string) {
	if strings.TrimSpace(projectID) == "" {
		return
	}
	subscribers := r.topicSubscribers(projectGitSubscription + projectID)
	if len(subscribers) == 0 {
		return
	}
	r.broadcastProjectGitTo(subscribers, workspaceProjectGitSnapshot(projectID))
}

func (r *workspaceConnectionRegistry) broadcastProjectGitSnapshot(projectID string, snapshot any) {
	if strings.TrimSpace(projectID) == "" {
		return
	}
	subscribers := r.topicSubscribers(projectGitSubscription + projectID)
	if len(subscribers) == 0 {
		return
	}
	r.broadcastProjectGitTo(subscribers, snapshot)
}

func (r *workspaceConnectionRegistry) broadcastProjectGitTo(subscribers map[*workspaceConnection][]string, snapshot any) {
	for conn, subscriptionIDs := range subscribers {
		for _, subscriptionID := range subscriptionIDs {
			_ = conn.write(protocol.SnapshotEnvelope(subscriptionID, protocol.SnapshotProjectGit, snapshot))
		}
	}
}

func workspaceAgentCoordinator() *agent.Coordinator {
	dir := workspaceDataDir()
	workspaceCoordinatorMu.Lock()
	defer workspaceCoordinatorMu.Unlock()
	if workspaceCoordinator != nil && workspaceCoordinatorDir == dir {
		return workspaceCoordinator
	}
	workspaceCoordinatorDir = dir
	store := eventstore.New(dir)
	workspaceCoordinator = agent.NewCoordinator(&workspaceEventStore{store: store}, workspaceTurnStarterFactory(store), func(chatID string) {
		workspaceConnections.scheduleBroadcast(chatID)
		workspaceTelegramBridge.chatStateChanged(chatID)
	})
	return workspaceCoordinator
}

// RecoverQueuedMessages rebuilds delivery after an app-server restart. Queue
// records are durable, but Coordinator.active is intentionally in-memory; a
// restart therefore needs an explicit pass to resume idle chats. A session
// owned by another Codex process is left untouched and remains actionable in
// the UI (take over or remove the queued rows).
func RecoverQueuedMessages() {
	store := workspaceStore()
	state, err := store.LoadStateLight()
	if err != nil {
		return
	}
	coordinator := workspaceAgentCoordinator()
	for chatID := range state.QueuedMessagesByChatID {
		workspaceRecoverQueuedMessage(state, coordinator, chatID)
	}
}

func workspaceRecoverQueuedMessage(state readmodels.StoreState, coordinator *agent.Coordinator, chatID string) bool {
	if len(state.QueuedMessagesByChatID[chatID]) == 0 {
		return false
	}
	chat, ok := state.ChatsByID[chatID]
	if !ok || chat.DeletedAt != 0 {
		return false
	}
	lock := workspaceCodexLockStatus(chat)
	if lock.State != codexLockAvailable && lock.State != codexLockOwnedByUs {
		return false
	}
	_ = coordinator.RecoverQueued(context.Background(), chatID)
	return true
}

// RecoverQueuedMessageForChat retries delivery after a user refreshes a chat
// or releases/takes over its Codex lock.
func RecoverQueuedMessageForChat(chatID string) {
	store := workspaceStore()
	state, err := store.LoadStateLight()
	if err != nil {
		return
	}
	workspaceRecoverQueuedMessage(state, workspaceAgentCoordinator(), chatID)
}

func (s *workspaceEventStore) CreateChat(projectID string) (readmodels.ChatRecord, error) {
	return s.CreateChatWithOptions(projectID, "", "")
}

func (s *workspaceEventStore) CreateChatWithOptions(projectID string, provider string, tmuxCommand string) (readmodels.ChatRecord, error) {
	project, err := s.requireProject(projectID)
	if err != nil {
		return readmodels.ChatRecord{}, err
	}
	now := time.Now().UnixMilli()
	chatID := "chat-" + randomID()
	title := "New Chat"
	provider = strings.TrimSpace(provider)
	tmuxCommand = strings.TrimSpace(tmuxCommand)
	data := map[string]any{
		"chatId":    chatID,
		"projectId": project.ID,
		"title":     title,
	}
	if provider != "" {
		data["provider"] = provider
	}
	if tmuxCommand != "" {
		data["tmuxCommand"] = tmuxCommand
	}
	event, err := events.NewAt(events.TypeChatCreated, now, data)
	if err != nil {
		return readmodels.ChatRecord{}, err
	}
	if err := s.store.Append(events.StreamChats, event); err != nil {
		return readmodels.ChatRecord{}, err
	}
	return readmodels.ChatRecord{
		ID:          chatID,
		ProjectID:   project.ID,
		Title:       title,
		Provider:    optionalString(provider),
		TmuxCommand: tmuxCommand,
		CreatedAt:   now,
		UpdatedAt:   now,
	}, nil
}

func (s *workspaceEventStore) RequireChat(chatID string) (readmodels.ChatRecord, error) {
	state, err := s.store.LoadState()
	if err != nil {
		return readmodels.ChatRecord{}, err
	}
	chat, ok := state.ChatsByID[chatID]
	if !ok || chat.DeletedAt != 0 {
		return readmodels.ChatRecord{}, errors.New("chat not found")
	}
	return chat, nil
}

func (s *workspaceEventStore) SetChatProvider(chatID string, provider string) error {
	event, err := events.New(events.TypeChatProviderSet, map[string]any{"chatId": chatID, "provider": provider})
	if err != nil {
		return err
	}
	return s.store.Append(events.StreamChats, event)
}

func (s *workspaceEventStore) SetTmuxLaunch(chatID string, provider string, tmuxCommand string) error {
	event, err := events.New(events.TypeChatRuntimeSet, map[string]any{
		"chatId":      chatID,
		"provider":    strings.TrimSpace(provider),
		"tmuxCommand": strings.TrimSpace(tmuxCommand),
	})
	if err != nil {
		return err
	}
	return s.store.Append(events.StreamChats, event)
}

func (s *workspaceEventStore) SetPlanMode(chatID string, planMode bool) error {
	event, err := events.New(events.TypeChatPlanModeSet, map[string]any{"chatId": chatID, "planMode": planMode})
	if err != nil {
		return err
	}
	return s.store.Append(events.StreamChats, event)
}

func workspaceSetChatPlanMode(raw json.RawMessage) (string, error) {
	var payload struct {
		ChatID   string `json:"chatId"`
		PlanMode bool   `json:"planMode"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return "", err
	}
	payload.ChatID = strings.TrimSpace(payload.ChatID)
	if payload.ChatID == "" {
		return "", errors.New("chatId is required")
	}
	store := &workspaceEventStore{store: workspaceStore()}
	if _, err := store.RequireChat(payload.ChatID); err != nil {
		return "", err
	}
	if err := store.SetPlanMode(payload.ChatID, payload.PlanMode); err != nil {
		return "", err
	}
	return payload.ChatID, nil
}

func (s *workspaceEventStore) SetSessionToken(chatID string, sessionToken string) error {
	event, err := events.New(events.TypeSessionTokenSet, map[string]any{"chatId": chatID, "sessionToken": &sessionToken})
	if err != nil {
		return err
	}
	if err := s.store.Append(events.StreamTurns, event); err != nil {
		return err
	}
	clearPending, err := events.New(events.TypePendingForkSessionTokenSet, map[string]any{"chatId": chatID, "pendingForkSessionToken": (*string)(nil)})
	if err != nil {
		return err
	}
	return s.store.Append(events.StreamTurns, clearPending)
}

func (s *workspaceEventStore) EnsureSystemInit(chatID string, provider string, model string) error {
	return nil
}

func (s *workspaceEventStore) AppendUserPrompt(chatID string, content string, attachments []readmodels.ChatAttachment, steered bool) error {
	return nil
}

func (s *workspaceEventStore) RecordCheckpointBeforeUserPrompt(chatID string, content string, attachments []readmodels.ChatAttachment, steered bool) error {
	record, err := workspaceCreateCheckpoint(workspaceCreateCheckpointArgs{
		ChatID:        chatID,
		Trigger:       workspaceCheckpointTriggerPrompt,
		PromptPreview: content,
	})
	if err != nil {
		return err
	}
	workspaceConnections.broadcastProjectGit(record.ProjectID)
	return nil
}

func (s *workspaceEventStore) RecordCheckpointTurnBoundary(chatID string, threadID string, turnID string) error {
	records := workspaceReadCheckpointRecords()
	for index := len(records) - 1; index >= 0; index-- {
		record := records[index]
		if record.ChatID != chatID || record.Trigger != workspaceCheckpointTriggerPrompt || record.BoundaryTurnID != "" {
			continue
		}
		record.BoundaryThreadID = threadID
		record.BoundaryTurnID = turnID
		return workspaceWriteCheckpointRecord(record)
	}
	return nil
}

func (s *workspaceEventStore) AppendTranscriptEntry(chatID string, entry readmodels.TranscriptEntry) error {
	return nil
}

func (s *workspaceEventStore) RecordToolCall(chatID string, request agent.PendingToolRequest) error {
	return nil
}

func (s *workspaceEventStore) RecordToolResult(chatID string, toolUseID string, result any) error {
	return nil
}

func (s *workspaceEventStore) RecordTurnStarted(chatID string) error {
	return s.appendTurn(events.TypeTurnStarted, chatID, nil)
}

func (s *workspaceEventStore) RecordTurnFinished(chatID string) error {
	return s.appendTurn(events.TypeTurnFinished, chatID, nil)
}

func (s *workspaceEventStore) RecordTurnFailed(chatID string, message string) error {
	return s.appendTurn(events.TypeTurnFailed, chatID, map[string]any{"message": message})
}

func (s *workspaceEventStore) RecordTurnCancelled(chatID string) error {
	return s.appendTurn(events.TypeTurnCancelled, chatID, nil)
}

func (s *workspaceEventStore) EnqueueMessage(chatID string, message agent.QueueMessageInput) (readmodels.QueuedChatMessage, error) {
	now := time.Now().UnixMilli()
	queuedID := ""
	if requestID := strings.TrimSpace(message.RequestID); requestID != "" {
		queuedID = "queued-" + requestID
		if existing, ok := s.GetQueuedMessage(chatID, queuedID); ok {
			return existing, nil
		}
	}
	if queuedID == "" {
		queuedID = "queued-" + randomID()
	}
	queued := readmodels.QueuedChatMessage{
		ID:           queuedID,
		Content:      message.Content,
		Attachments:  append(make([]readmodels.ChatAttachment, 0, len(message.Attachments)), message.Attachments...),
		CreatedAt:    now,
		Model:        message.Model,
		ModelOptions: message.ModelOptions,
	}
	if message.Provider != "" {
		queued.Provider = &message.Provider
	}
	queued.PlanMode = &message.PlanMode
	event, err := events.NewAt(events.TypeQueuedMessageEnqueued, now, map[string]any{"chatId": chatID, "message": queued})
	if err != nil {
		return readmodels.QueuedChatMessage{}, err
	}
	if err := s.store.Append(events.StreamQueuedMessages, event); err != nil {
		return readmodels.QueuedChatMessage{}, err
	}
	return queued, nil
}

func (s *workspaceEventStore) GetQueuedMessages(chatID string) []readmodels.QueuedChatMessage {
	state, err := s.store.LoadState()
	if err != nil {
		return nil
	}
	return append([]readmodels.QueuedChatMessage(nil), state.QueuedMessagesByChatID[chatID]...)
}

func (s *workspaceEventStore) GetQueuedMessage(chatID string, queuedMessageID string) (readmodels.QueuedChatMessage, bool) {
	for _, message := range s.GetQueuedMessages(chatID) {
		if message.ID == queuedMessageID {
			return message, true
		}
	}
	return readmodels.QueuedChatMessage{}, false
}

func (s *workspaceEventStore) RemoveQueuedMessage(chatID string, queuedMessageID string) error {
	event, err := events.New(events.TypeQueuedMessageRemoved, map[string]any{"chatId": chatID, "queuedMessageId": queuedMessageID})
	if err != nil {
		return err
	}
	return s.store.Append(events.StreamQueuedMessages, event)
}

func (s *workspaceEventStore) UpdateQueuedMessage(chatID string, queuedMessageID string, content string) error {
	event, err := events.New(events.TypeQueuedMessageUpdated, map[string]any{"chatId": chatID, "queuedMessageId": queuedMessageID, "content": content})
	if err != nil {
		return err
	}
	return s.store.Append(events.StreamQueuedMessages, event)
}

func (s *workspaceEventStore) MarkQueuedMessageSteered(chatID string, queuedMessageID string) error {
	event, err := events.New(events.TypeQueuedMessageSteered, map[string]any{"chatId": chatID, "queuedMessageId": queuedMessageID})
	if err != nil {
		return err
	}
	return s.store.Append(events.StreamQueuedMessages, event)
}

func (s *workspaceEventStore) appendTurn(eventType string, chatID string, extra map[string]any) error {
	data := map[string]any{"chatId": chatID}
	for key, value := range extra {
		data[key] = value
	}
	event, err := events.New(eventType, data)
	if err != nil {
		return err
	}
	if err := s.store.Append(events.StreamTurns, event); err != nil {
		return err
	}
	// Turn outcomes can be written by the coordinator without going through a
	// websocket command broadcast. Their sidebar status must still replace a
	// cached snapshot immediately.
	workspaceInvalidateSidebarSnapshot()
	return nil
}

func (s *workspaceEventStore) requireProject(projectID string) (readmodels.ProjectRecord, error) {
	state, err := s.store.LoadState()
	if err != nil {
		return readmodels.ProjectRecord{}, err
	}
	project, ok := state.ProjectsByID[projectID]
	if !ok || project.DeletedAt != 0 {
		return readmodels.ProjectRecord{}, errors.New("project not found")
	}
	return project, nil
}

func workspaceOpenProject(localPath string, title string) (readmodels.ProjectRecord, error) {
	localPath = strings.TrimSpace(localPath)
	if localPath == "" {
		return readmodels.ProjectRecord{}, errors.New("localPath is required")
	}
	if title = strings.TrimSpace(title); title == "" {
		title = filepath.Base(localPath)
	}
	store := workspaceStore()
	state, err := store.LoadState()
	if err != nil {
		return readmodels.ProjectRecord{}, err
	}
	if projectID := state.ProjectIDsByPath[localPath]; projectID != "" {
		if project, ok := state.ProjectsByID[projectID]; ok && project.DeletedAt == 0 {
			return project, nil
		}
	}
	now := time.Now().UnixMilli()
	project := readmodels.ProjectRecord{
		ID:        "project-" + randomID(),
		LocalPath: localPath,
		Title:     title,
		CreatedAt: now,
		UpdatedAt: now,
	}
	event, err := events.NewAt(events.TypeProjectOpened, now, map[string]any{
		"projectId": project.ID,
		"localPath": project.LocalPath,
		"title":     project.Title,
	})
	if err != nil {
		return readmodels.ProjectRecord{}, err
	}
	if err := store.Append(events.StreamProjects, event); err != nil {
		return readmodels.ProjectRecord{}, err
	}
	return project, nil
}

func workspaceCreateChat(projectID string) (readmodels.ChatRecord, error) {
	return (&workspaceEventStore{store: workspaceStore()}).CreateChat(projectID)
}

func workspaceCreateChatWithOptions(projectID string, provider string, tmuxCommand string) (readmodels.ChatRecord, error) {
	return (&workspaceEventStore{store: workspaceStore()}).CreateChatWithOptions(projectID, provider, tmuxCommand)
}

func optionalString(value string) *string {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	return &value
}

func workspaceChatTmuxSession(chatID string) string { return "abolqasem-" + strings.TrimSpace(chatID) }

func workspaceMarkChatRead(chatID string) error {
	chatID = strings.TrimSpace(chatID)
	if chatID == "" {
		return errors.New("chatId is required")
	}

	storeState, err := workspaceStore().LoadStateLight()
	if err != nil {
		return err
	}
	if err := workspaceClearLegacySessionUnread(chatID, storeState); err != nil {
		return err
	}

	chat, ok := storeState.ChatsByID[chatID]
	if !ok || chat.DeletedAt != 0 {
		return nil
	}

	event, err := events.New(events.TypeChatReadStateSet, map[string]any{"chatId": chatID, "unread": false})
	if err != nil {
		return err
	}
	return workspaceStore().Append(events.StreamChats, event)
}

func workspaceClearLegacySessionUnread(chatID string, storeState readmodels.StoreState) error {
	appState, err := workspaceLoadLegacyState()
	if err != nil || appState == nil {
		return nil
	}

	cleared := false
	if meta, ok := workspaceLegacySessionByChatID(chatID); ok {
		cleared = state.MarkSessionRead(appState, meta.Key) || cleared
	}
	if chat, ok := storeState.ChatsByID[chatID]; ok && chat.DeletedAt == 0 {
		if meta, ok := workspaceLegacySessionByProviderToken(derefWorkspaceString(chat.Provider), derefWorkspaceString(chat.SessionToken)); ok {
			cleared = state.MarkSessionRead(appState, meta.Key) || cleared
		}
	}
	if !cleared {
		return nil
	}
	return workspaceSaveLegacyState(appState)
}

func workspaceAppendAssistantText(chatID string, text string) error {
	if strings.TrimSpace(chatID) == "" {
		return errors.New("chatId is required")
	}
	if strings.TrimSpace(text) == "" {
		return nil
	}
	workspaceConnections.broadcast(chatID)
	return nil
}

func (c *workspaceConnection) emitWorkspaceSnapshots(chatID string) {
	c.subscriptionsMu.Lock()
	subscriptions := make(map[string]workspaceSubscription, len(c.subscriptions))
	for subscriptionID, subscription := range c.subscriptions {
		subscriptions[subscriptionID] = subscription
	}
	c.subscriptionsMu.Unlock()

	for subscriptionID, subscription := range subscriptions {
		topic := subscription.key
		switch {
		case topic == sidebarSubscription:
			_ = c.write(protocol.SnapshotEnvelope(subscriptionID, protocol.SnapshotSidebar, workspaceSidebarSnapshot()))
		case topic == localProjectsSubscription:
			_ = c.write(protocol.SnapshotEnvelope(subscriptionID, protocol.SnapshotLocalProjects, workspaceLocalProjectsSnapshot()))
		case chatID != "" && topic == chatSubscription+chatID:
			_ = c.write(protocol.SnapshotEnvelope(subscriptionID, protocol.SnapshotChat, workspaceChatSnapshot(chatID, subscriptionRecentLimit(subscription.topic))))
		}
	}
}

func decodeSendCommand(raw json.RawMessage) (agent.SendCommand, error) {
	var payload struct {
		ChatID       string                      `json:"chatId"`
		ProjectID    string                      `json:"projectId"`
		Content      string                      `json:"content"`
		Attachments  []readmodels.ChatAttachment `json:"attachments"`
		Provider     string                      `json:"provider"`
		Model        string                      `json:"model"`
		ModelOptions *catalog.ModelOptions       `json:"modelOptions"`
		Effort       string                      `json:"effort"`
		PlanMode     bool                        `json:"planMode"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return agent.SendCommand{}, err
	}
	return agent.SendCommand{
		ChatID:       payload.ChatID,
		ProjectID:    payload.ProjectID,
		Content:      payload.Content,
		Attachments:  payload.Attachments,
		Provider:     payload.Provider,
		Model:        payload.Model,
		ModelOptions: payload.ModelOptions,
		Effort:       payload.Effort,
		PlanMode:     payload.PlanMode,
	}, nil
}

func decodeQueueCommand(raw json.RawMessage) (agent.SendCommand, error) {
	return decodeSendCommand(raw)
}

func decodeChatID(raw json.RawMessage) (string, error) {
	var payload struct {
		ChatID string `json:"chatId"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return "", err
	}
	if strings.TrimSpace(payload.ChatID) == "" {
		return "", errors.New("chatId is required")
	}
	return payload.ChatID, nil
}

func decodeChatRefreshCommand(raw json.RawMessage) (string, bool, error) {
	var payload struct {
		ChatID                 string `json:"chatId"`
		ForceTranscriptRefresh bool   `json:"forceTranscriptRefresh"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return "", false, err
	}
	chatID := strings.TrimSpace(payload.ChatID)
	if chatID == "" {
		return "", false, errors.New("chatId is required")
	}
	return chatID, payload.ForceTranscriptRefresh, nil
}

func decodeQueuedMessageCommand(raw json.RawMessage) (string, string, error) {
	var payload struct {
		ChatID          string `json:"chatId"`
		QueuedMessageID string `json:"queuedMessageId"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return "", "", err
	}
	if strings.TrimSpace(payload.ChatID) == "" {
		return "", "", errors.New("chatId is required")
	}
	if strings.TrimSpace(payload.QueuedMessageID) == "" {
		return "", "", errors.New("queuedMessageId is required")
	}
	return payload.ChatID, payload.QueuedMessageID, nil
}

func decodeEditQueuedMessageCommand(raw json.RawMessage) (string, string, string, error) {
	var payload struct {
		ChatID          string `json:"chatId"`
		QueuedMessageID string `json:"queuedMessageId"`
		Content         string `json:"content"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return "", "", "", err
	}
	if strings.TrimSpace(payload.ChatID) == "" {
		return "", "", "", errors.New("chatId is required")
	}
	if strings.TrimSpace(payload.QueuedMessageID) == "" {
		return "", "", "", errors.New("queuedMessageId is required")
	}
	return payload.ChatID, payload.QueuedMessageID, payload.Content, nil
}

func decodeToolResponseCommand(raw json.RawMessage) (agent.ToolResponseCommand, error) {
	var payload struct {
		ChatID    string `json:"chatId"`
		ToolUseID string `json:"toolUseId"`
		Result    any    `json:"result"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return agent.ToolResponseCommand{}, err
	}
	if strings.TrimSpace(payload.ChatID) == "" {
		return agent.ToolResponseCommand{}, errors.New("chatId is required")
	}
	if strings.TrimSpace(payload.ToolUseID) == "" {
		return agent.ToolResponseCommand{}, errors.New("toolUseId is required")
	}
	return agent.ToolResponseCommand{
		ChatID:    payload.ChatID,
		ToolUseID: payload.ToolUseID,
		Result:    payload.Result,
	}, nil
}
