package agent

import (
	"context"
	"errors"
	"reflect"
	"sync"
	"testing"
	"time"

	"abolqasem/internal/providers/catalog"
	"abolqasem/internal/workspace/readmodels"
	"abolqasem/internal/workspace/transcript"
)

func TestSendStartsTurnAndBlocksConcurrentTurn(t *testing.T) {
	store := newFakeStore()
	starter := TurnStarterFunc(func(context.Context, TurnRequest) (Turn, error) {
		return &fakeTurn{}, nil
	})
	coordinator := NewCoordinator(store, starter, nil)

	result, err := coordinator.Send(context.Background(), SendCommand{
		ChatID:   "chat-1",
		Content:  "hello",
		Provider: "codex",
	})
	if err != nil {
		t.Fatalf("Send returned error: %v", err)
	}
	if result.ChatID != "chat-1" || result.Queued {
		t.Fatalf("unexpected result: %#v", result)
	}
	if store.started != 1 {
		t.Fatalf("expected one started turn, got %d", store.started)
	}

	queued, err := coordinator.Send(context.Background(), SendCommand{
		ChatID:  "chat-1",
		Content: "follow up",
	})
	if err != nil {
		t.Fatalf("queued Send returned error: %v", err)
	}
	if !queued.Queued || queued.QueuedMessageID == "" {
		t.Fatalf("expected queued result, got %#v", queued)
	}
	if len(store.queued["chat-1"]) != 1 {
		t.Fatalf("expected one queued message, got %#v", store.queued["chat-1"])
	}
}

func TestSendPropagatesCodexExecutionMode(t *testing.T) {
	store := newFakeStore()
	var started TurnRequest
	coordinator := NewCoordinator(store, TurnStarterFunc(func(_ context.Context, request TurnRequest) (Turn, error) {
		started = request
		return &fakeTurn{}, nil
	}), nil)

	_, err := coordinator.Send(context.Background(), SendCommand{
		ChatID:   "chat-1",
		Content:  "safe change",
		Provider: "codex",
		ModelOptions: &catalog.ModelOptions{Codex: &catalog.CodexModelOptionsPatch{
			ExecutionMode: "standard",
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if started.ExecutionMode != "standard" {
		t.Fatalf("expected standard execution mode, got %#v", started)
	}
}

func TestCancelRemovesActiveTurn(t *testing.T) {
	store := newFakeStore()
	turn := &fakeTurn{}
	coordinator := NewCoordinator(store, TurnStarterFunc(func(context.Context, TurnRequest) (Turn, error) {
		return turn, nil
	}), nil)

	if _, err := coordinator.Send(context.Background(), SendCommand{ChatID: "chat-1", Content: "hello"}); err != nil {
		t.Fatalf("Send returned error: %v", err)
	}
	if err := coordinator.Cancel("chat-1"); err != nil {
		t.Fatalf("Cancel returned error: %v", err)
	}
	if !turn.cancelled {
		t.Fatal("expected turn to be cancelled")
	}
	if store.cancelled != 1 {
		t.Fatalf("expected one cancellation record, got %d", store.cancelled)
	}
	if len(coordinator.ActiveStatuses()) != 0 {
		t.Fatalf("expected no active statuses, got %#v", coordinator.ActiveStatuses())
	}
}

func TestProviderStartFailureRecordsFailure(t *testing.T) {
	store := newFakeStore()
	coordinator := NewCoordinator(store, TurnStarterFunc(func(context.Context, TurnRequest) (Turn, error) {
		return nil, errors.New("provider failed")
	}), nil)

	if _, err := coordinator.Send(context.Background(), SendCommand{ChatID: "chat-1", Content: "hello"}); err == nil {
		t.Fatal("expected send error")
	}
	if store.failed != 1 {
		t.Fatalf("expected one failure record, got %d", store.failed)
	}
	if len(coordinator.ActiveStatuses()) != 0 {
		t.Fatalf("expected no active statuses after failure, got %#v", coordinator.ActiveStatuses())
	}
}

func TestCancelCancelsTurnContext(t *testing.T) {
	store := newFakeStore()
	var turnContext context.Context
	coordinator := NewCoordinator(store, TurnStarterFunc(func(ctx context.Context, _ TurnRequest) (Turn, error) {
		turnContext = ctx
		return &fakeTurn{}, nil
	}), nil)

	if _, err := coordinator.Send(context.Background(), SendCommand{ChatID: "chat-1", Content: "hello"}); err != nil {
		t.Fatalf("Send returned error: %v", err)
	}
	if turnContext == nil {
		t.Fatal("expected turn context")
	}
	if err := coordinator.Cancel("chat-1"); err != nil {
		t.Fatalf("Cancel returned error: %v", err)
	}
	select {
	case <-turnContext.Done():
	default:
		t.Fatal("expected turn context to be cancelled")
	}
}

func TestPendingToolSnapshot(t *testing.T) {
	store := newFakeStore()
	coordinator := NewCoordinator(store, TurnStarterFunc(func(context.Context, TurnRequest) (Turn, error) {
		return &fakeTurn{}, nil
	}), nil)

	if _, err := coordinator.Send(context.Background(), SendCommand{ChatID: "chat-1", Content: "hello"}); err != nil {
		t.Fatalf("Send returned error: %v", err)
	}
	if err := coordinator.SetPendingTool("chat-1", PendingToolRequest{
		ToolUseID: "tool-1",
		ToolKind:  "ask_user_question",
		ToolName:  "AskUserQuestion",
		Input:     map[string]any{"questions": []string{"Choose one"}},
	}); err != nil {
		t.Fatalf("SetPendingTool returned error: %v", err)
	}
	pending := coordinator.PendingTool("chat-1")
	if pending == nil {
		t.Fatal("expected pending tool")
	}
	if pending.ToolUseID != "tool-1" || pending.ToolKind != "ask_user_question" || pending.ToolName != "AskUserQuestion" {
		t.Fatalf("unexpected pending tool: %#v", pending)
	}
	if pending.CreatedAt <= 0 || !reflect.DeepEqual(pending.Input, map[string]any{"questions": []string{"Choose one"}}) {
		t.Fatalf("expected pending tool details, got %#v", pending)
	}
	if got := coordinator.ActiveStatuses()["chat-1"]; got != readmodels.StatusWaitingForUser {
		t.Fatalf("expected waiting_for_user status, got %q", got)
	}
}

func TestRespondToolForwardsResultAndClearsPendingState(t *testing.T) {
	store := newFakeStore()
	turn := &fakeTurn{}
	coordinator := NewCoordinator(store, TurnStarterFunc(func(context.Context, TurnRequest) (Turn, error) {
		return turn, nil
	}), nil)

	if _, err := coordinator.Send(context.Background(), SendCommand{ChatID: "chat-1", Content: "hello"}); err != nil {
		t.Fatalf("Send returned error: %v", err)
	}
	if err := coordinator.SetPendingTool("chat-1", PendingToolRequest{
		ToolUseID: "tool-1",
		ToolKind:  "ask_user_question",
	}); err != nil {
		t.Fatalf("SetPendingTool returned error: %v", err)
	}

	result := map[string]any{"answer": "yes"}
	if err := coordinator.RespondTool(context.Background(), ToolResponseCommand{
		ChatID:    "chat-1",
		ToolUseID: "tool-1",
		Result:    result,
	}); err != nil {
		t.Fatalf("RespondTool returned error: %v", err)
	}
	if turn.toolResponse.ToolUseID != "tool-1" {
		t.Fatalf("expected tool response to be forwarded, got %#v", turn.toolResponse)
	}
	if coordinator.PendingTool("chat-1") != nil {
		t.Fatalf("expected pending tool to be cleared")
	}
	if got := coordinator.ActiveStatuses()["chat-1"]; got != readmodels.StatusRunning {
		t.Fatalf("expected running status, got %q", got)
	}
}

func TestRespondToolRejectsMismatchedPendingTool(t *testing.T) {
	store := newFakeStore()
	turn := &fakeTurn{}
	coordinator := NewCoordinator(store, TurnStarterFunc(func(context.Context, TurnRequest) (Turn, error) {
		return turn, nil
	}), nil)

	if _, err := coordinator.Send(context.Background(), SendCommand{ChatID: "chat-1", Content: "hello"}); err != nil {
		t.Fatalf("Send returned error: %v", err)
	}
	if err := coordinator.SetPendingTool("chat-1", PendingToolRequest{
		ToolUseID: "tool-1",
		ToolKind:  "ask_user_question",
	}); err != nil {
		t.Fatalf("SetPendingTool returned error: %v", err)
	}

	err := coordinator.RespondTool(context.Background(), ToolResponseCommand{
		ChatID:    "chat-1",
		ToolUseID: "other-tool",
		Result:    "ignored",
	})
	if !errors.Is(err, ErrPendingToolNotFound) {
		t.Fatalf("expected ErrPendingToolNotFound, got %v", err)
	}
	if turn.toolResponse.ToolUseID != "" {
		t.Fatalf("expected no forwarded response, got %#v", turn.toolResponse)
	}
	if coordinator.PendingTool("chat-1") == nil {
		t.Fatalf("expected original pending tool to remain")
	}
}

func TestFinishStartsNextQueuedMessage(t *testing.T) {
	store := newFakeStore()
	var startedContents []string
	coordinator := NewCoordinator(store, TurnStarterFunc(func(_ context.Context, request TurnRequest) (Turn, error) {
		startedContents = append(startedContents, request.Content)
		return &fakeTurn{}, nil
	}), nil)

	if _, err := coordinator.Send(context.Background(), SendCommand{ChatID: "chat-1", Content: "first"}); err != nil {
		t.Fatalf("Send returned error: %v", err)
	}
	if _, err := coordinator.Send(context.Background(), SendCommand{ChatID: "chat-1", Content: "second"}); err != nil {
		t.Fatalf("queued Send returned error: %v", err)
	}
	if err := coordinator.Finish("chat-1"); err != nil {
		t.Fatalf("Finish returned error: %v", err)
	}
	if store.finished != 1 {
		t.Fatalf("expected one finished turn, got %d", store.finished)
	}
	if len(startedContents) != 2 || startedContents[0] != "first" || startedContents[1] != "second" {
		t.Fatalf("expected queued message to start, got %#v", startedContents)
	}
	if len(store.queued["chat-1"]) != 0 {
		t.Fatalf("expected queue to be empty, got %#v", store.queued["chat-1"])
	}
	if coordinator.ActiveStatuses()["chat-1"] == "" {
		t.Fatalf("expected next queued turn to be active")
	}
}

func TestFailedTurnStartsNextQueuedMessage(t *testing.T) {
	store := newFakeStore()
	var startedContents []string
	coordinator := NewCoordinator(store, TurnStarterFunc(func(_ context.Context, request TurnRequest) (Turn, error) {
		startedContents = append(startedContents, request.Content)
		return &fakeTurn{}, nil
	}), nil)
	if _, err := coordinator.Send(context.Background(), SendCommand{ChatID: "chat-1", Content: "first"}); err != nil {
		t.Fatal(err)
	}
	if _, err := coordinator.Send(context.Background(), SendCommand{ChatID: "chat-1", Content: "next"}); err != nil {
		t.Fatal(err)
	}
	active := coordinator.active["chat-1"]
	if err := coordinator.failFromProvider("chat-1", active, errors.New("provider failed")); err != nil {
		t.Fatal(err)
	}
	if store.failed != 1 || len(startedContents) != 2 || startedContents[1] != "next" {
		t.Fatalf("expected failed turn to advance the queue, failed=%d started=%#v", store.failed, startedContents)
	}
}

func TestQueuedMessagesAdvanceWhenTheirStartFails(t *testing.T) {
	store := newFakeStore()
	var startedContents []string
	coordinator := NewCoordinator(store, TurnStarterFunc(func(_ context.Context, request TurnRequest) (Turn, error) {
		startedContents = append(startedContents, request.Content)
		if request.Content == "second" {
			return nil, errors.New("provider unavailable")
		}
		return &fakeTurn{}, nil
	}), nil)
	if _, err := coordinator.Send(context.Background(), SendCommand{ChatID: "chat-1", Content: "first"}); err != nil {
		t.Fatal(err)
	}
	for _, content := range []string{"second", "third"} {
		if _, err := coordinator.Send(context.Background(), SendCommand{ChatID: "chat-1", Content: content}); err != nil {
			t.Fatal(err)
		}
	}

	if err := coordinator.Finish("chat-1"); err == nil {
		t.Fatal("expected the failed queued start to be reported")
	}
	if !reflect.DeepEqual(startedContents, []string{"first", "second", "third"}) {
		t.Fatalf("expected queue to advance past failed start, got %#v", startedContents)
	}
	if len(store.queued["chat-1"]) != 0 {
		t.Fatalf("expected queue to be empty, got %#v", store.queued["chat-1"])
	}
	if coordinator.ActiveStatuses()["chat-1"] == "" {
		t.Fatal("expected third queued turn to be active")
	}
}

func TestDequeueRemovesQueuedMessage(t *testing.T) {
	store := newFakeStore()
	coordinator := NewCoordinator(store, nil, nil)
	queuedID, err := coordinator.Enqueue(SendCommand{ChatID: "chat-1", Content: "queued"})
	if err != nil {
		t.Fatalf("Enqueue returned error: %v", err)
	}
	if err := coordinator.Dequeue("chat-1", queuedID); err != nil {
		t.Fatalf("Dequeue returned error: %v", err)
	}
	if len(store.queued["chat-1"]) != 0 {
		t.Fatalf("expected queue to be empty, got %#v", store.queued["chat-1"])
	}
}

func TestQueuedDeliveryCommandsAreIdempotentAfterRemoval(t *testing.T) {
	store := newFakeStore()
	coordinator := NewCoordinator(store, nil, nil)

	if err := coordinator.Dequeue("chat-1", "already-removed"); err != nil {
		t.Fatalf("repeated Dequeue returned error: %v", err)
	}
	if err := coordinator.SteerQueued(context.Background(), "chat-1", "already-removed"); err != nil {
		t.Fatalf("repeated SteerQueued returned error: %v", err)
	}
	if err := coordinator.InterruptQueued(context.Background(), "chat-1", "already-removed"); err != nil {
		t.Fatalf("repeated InterruptQueued returned error: %v", err)
	}
}

func TestEditAndSteerQueuedMessageRemovesAcceptedDelivery(t *testing.T) {
	store := newFakeStore()
	turn := &fakeTurn{}
	coordinator := NewCoordinator(store, TurnStarterFunc(func(context.Context, TurnRequest) (Turn, error) { return turn, nil }), nil)
	if _, err := coordinator.Send(context.Background(), SendCommand{ChatID: "chat-1", Content: "first"}); err != nil {
		t.Fatal(err)
	}
	queuedID, err := coordinator.Enqueue(SendCommand{ChatID: "chat-1", Content: "old"})
	if err != nil {
		t.Fatal(err)
	}
	if err := coordinator.EditQueued("chat-1", queuedID, "new"); err != nil {
		t.Fatal(err)
	}
	if err := coordinator.SteerQueued(context.Background(), "chat-1", queuedID); err != nil {
		t.Fatal(err)
	}
	if turn.steeredContent != "new" {
		t.Fatalf("expected edited content to be steered, got %q", turn.steeredContent)
	}
	if len(store.queued["chat-1"]) != 0 {
		t.Fatalf("expected accepted steer to leave the durable queue, got %#v", store.queued["chat-1"])
	}
}

func TestReconcileQueuedRemovesLegacySteeringMessages(t *testing.T) {
	store := newFakeStore()
	store.queued["chat-1"] = []readmodels.QueuedChatMessage{
		{ID: "delivered", Content: "already sent", DeliveryState: "steering"},
		{ID: "waiting", Content: "still queued"},
	}
	stateChanges := 0
	coordinator := NewCoordinator(store, nil, func(string) { stateChanges++ })

	if err := coordinator.ReconcileQueued("chat-1"); err != nil {
		t.Fatalf("ReconcileQueued returned error: %v", err)
	}
	if len(store.queued["chat-1"]) != 1 || store.queued["chat-1"][0].ID != "waiting" {
		t.Fatalf("expected only the undelivered message to remain, got %#v", store.queued["chat-1"])
	}
	if stateChanges != 1 {
		t.Fatalf("expected one reconciliation state change, got %d", stateChanges)
	}
}

func TestRecoverQueuedStartsDurableMessageAfterRestart(t *testing.T) {
	store := newFakeStore()
	store.queued["chat-1"] = []readmodels.QueuedChatMessage{{ID: "queued-1", Content: "resume me"}}
	var request TurnRequest
	coordinator := NewCoordinator(store, TurnStarterFunc(func(_ context.Context, got TurnRequest) (Turn, error) {
		request = got
		return &fakeTurn{}, nil
	}), nil)

	if err := coordinator.RecoverQueued(context.Background(), "chat-1"); err != nil {
		t.Fatalf("RecoverQueued returned error: %v", err)
	}
	if request.Content != "resume me" {
		t.Fatalf("expected durable message to be resumed, got %q", request.Content)
	}
	if len(store.GetQueuedMessages("chat-1")) != 0 {
		t.Fatalf("expected resumed message to leave the queue, got %#v", store.GetQueuedMessages("chat-1"))
	}
}

func TestInterruptQueuedMessagePublishesRemovalBeforeStartingReplacementTurn(t *testing.T) {
	store := newFakeStore()
	stateChanges := 0
	stateChangesBeforeReplacement := 0
	var starts int
	coordinator := NewCoordinator(store, TurnStarterFunc(func(context.Context, TurnRequest) (Turn, error) {
		starts++
		if starts == 2 {
			stateChangesBeforeReplacement = stateChanges
		}
		return &fakeTurn{}, nil
	}), func(string) {
		stateChanges++
	})

	if _, err := coordinator.Send(context.Background(), SendCommand{ChatID: "chat-1", Content: "first"}); err != nil {
		t.Fatal(err)
	}
	queuedID, err := coordinator.Enqueue(SendCommand{ChatID: "chat-1", Content: "send immediately"})
	if err != nil {
		t.Fatal(err)
	}
	if err := coordinator.InterruptQueued(context.Background(), "chat-1", queuedID); err != nil {
		t.Fatal(err)
	}
	if starts != 2 {
		t.Fatalf("expected replacement turn to start, got %d starts", starts)
	}
	if stateChangesBeforeReplacement < 4 {
		t.Fatalf("expected queue removal to be published before replacement starts, got %d state changes", stateChangesBeforeReplacement)
	}
	if len(store.queued["chat-1"]) != 0 {
		t.Fatalf("expected interrupted queued message to be removed, got %#v", store.queued["chat-1"])
	}
}

func TestSteerQueuedMessageStartsNewTurnWhenProviderTurnAlreadyEnded(t *testing.T) {
	store := newFakeStore()
	staleTurn := &fakeTurn{steerErr: errors.New("codex app-server rpc turn/steer failed: no active turn to steer")}
	startedContents := []string{}
	coordinator := NewCoordinator(store, TurnStarterFunc(func(_ context.Context, request TurnRequest) (Turn, error) {
		startedContents = append(startedContents, request.Content)
		if len(startedContents) == 1 {
			return staleTurn, nil
		}
		return &fakeTurn{}, nil
	}), nil)
	if _, err := coordinator.Send(context.Background(), SendCommand{ChatID: "chat-1", Content: "first"}); err != nil {
		t.Fatal(err)
	}
	queuedID, err := coordinator.Enqueue(SendCommand{ChatID: "chat-1", Content: "queued follow-up"})
	if err != nil {
		t.Fatal(err)
	}
	if err := coordinator.SteerQueued(context.Background(), "chat-1", queuedID); err != nil {
		t.Fatalf("expected stale steer to fall back to a new turn, got %v", err)
	}
	if len(startedContents) != 2 || startedContents[1] != "queued follow-up" {
		t.Fatalf("expected queued content to start as a new turn, got %#v", startedContents)
	}
	if len(store.queued["chat-1"]) != 0 {
		t.Fatalf("expected fallback message removed from queue, got %#v", store.queued["chat-1"])
	}
}

func TestActiveTurnIncludesProjectAndStartedAt(t *testing.T) {
	store := newFakeStore()
	coordinator := NewCoordinator(store, TurnStarterFunc(func(context.Context, TurnRequest) (Turn, error) {
		return &fakeTurn{}, nil
	}), nil)

	if _, err := coordinator.Send(context.Background(), SendCommand{ChatID: "chat-1", Content: "hello"}); err != nil {
		t.Fatalf("Send returned error: %v", err)
	}

	coordinator.mu.Lock()
	active := coordinator.active["chat-1"]
	coordinator.mu.Unlock()
	if active == nil {
		t.Fatal("expected active turn")
	}
	if active.ProjectID != "project-1" {
		t.Fatalf("expected project id, got %q", active.ProjectID)
	}
	if active.StartedAt.IsZero() {
		t.Fatal("expected startedAt to be set")
	}
}

func TestTurnEventStreamUpdatesTranscriptSessionAndDraining(t *testing.T) {
	store := newFakeStore()
	events := make(chan TurnEvent, 4)
	coordinator := NewCoordinator(store, TurnStarterFunc(func(context.Context, TurnRequest) (Turn, error) {
		return &fakeTurn{events: events}, nil
	}), nil)

	if _, err := coordinator.Send(context.Background(), SendCommand{ChatID: "chat-1", Content: "hello"}); err != nil {
		t.Fatalf("Send returned error: %v", err)
	}
	events <- TurnEvent{Type: TurnEventSessionToken, SessionToken: "thread-1"}
	events <- TurnEvent{Type: TurnEventTranscript, Entry: transcript.New(transcript.KindAssistantText, map[string]any{"text": "done"})}
	events <- TurnEvent{Type: TurnEventDraining, Draining: true}

	waitForCondition(t, func() bool {
		store.mu.Lock()
		token := store.sessionTokens["chat-1"]
		entryCount := len(store.entries["chat-1"])
		store.mu.Unlock()
		return token == "thread-1" && entryCount == 1 && coordinator.DrainingChatIDs()["chat-1"]
	})

	coordinator.StopDraining("chat-1")
	if coordinator.DrainingChatIDs()["chat-1"] {
		t.Fatal("expected StopDraining to clear the draining flag")
	}

	close(events)
	waitForCondition(t, func() bool {
		store.mu.Lock()
		finished := store.finished
		store.mu.Unlock()
		return finished == 1 && len(coordinator.ActiveStatuses()) == 0
	})
}

func TestTurnStartedEventPromotesCodexFromStartingToRunning(t *testing.T) {
	store := newFakeStore()
	events := make(chan TurnEvent, 1)
	coordinator := NewCoordinator(store, TurnStarterFunc(func(context.Context, TurnRequest) (Turn, error) {
		return &fakeTurn{events: events}, nil
	}), nil)

	if _, err := coordinator.Send(context.Background(), SendCommand{ChatID: "chat-1", Content: "hello", Provider: "codex"}); err != nil {
		t.Fatalf("Send returned error: %v", err)
	}
	if got := coordinator.ActiveStatuses()["chat-1"]; got != readmodels.StatusStarting {
		t.Fatalf("expected starting before app-server acknowledgement, got %q", got)
	}

	events <- TurnEvent{Type: TurnEventStarted, SessionToken: "thread-1", TurnID: "turn-1"}
	waitForCondition(t, func() bool {
		return coordinator.ActiveStatuses()["chat-1"] == readmodels.StatusRunning
	})
	close(events)
}

func TestTurnEventStreamStartsQueuedMessageAfterClose(t *testing.T) {
	store := newFakeStore()
	firstEvents := make(chan TurnEvent)
	secondEvents := make(chan TurnEvent)
	var startedMu sync.Mutex
	started := 0
	coordinator := NewCoordinator(store, TurnStarterFunc(func(context.Context, TurnRequest) (Turn, error) {
		startedMu.Lock()
		started++
		current := started
		startedMu.Unlock()
		if current == 1 {
			return &fakeTurn{events: firstEvents}, nil
		}
		return &fakeTurn{events: secondEvents}, nil
	}), nil)

	if _, err := coordinator.Send(context.Background(), SendCommand{ChatID: "chat-1", Content: "first"}); err != nil {
		t.Fatalf("Send returned error: %v", err)
	}
	if _, err := coordinator.Send(context.Background(), SendCommand{ChatID: "chat-1", Content: "second"}); err != nil {
		t.Fatalf("queued Send returned error: %v", err)
	}

	close(firstEvents)
	waitForCondition(t, func() bool {
		store.mu.Lock()
		finished := store.finished
		queuedCount := len(store.queued["chat-1"])
		store.mu.Unlock()
		startedMu.Lock()
		startedCount := started
		startedMu.Unlock()
		return finished == 1 && startedCount == 2 && queuedCount == 0
	})
	close(secondEvents)
}

func TestTurnEventStreamPendingToolLifecycle(t *testing.T) {
	store := newFakeStore()
	events := make(chan TurnEvent, 1)
	turn := &fakeTurn{events: events}
	coordinator := NewCoordinator(store, TurnStarterFunc(func(context.Context, TurnRequest) (Turn, error) {
		return turn, nil
	}), nil)

	if _, err := coordinator.Send(context.Background(), SendCommand{ChatID: "chat-1", Content: "hello"}); err != nil {
		t.Fatalf("Send returned error: %v", err)
	}
	events <- TurnEvent{
		Type: TurnEventPendingTool,
		PendingTool: &PendingToolRequest{
			ToolUseID: "tool-1",
			ToolKind:  "ask_user_question",
		},
	}
	waitForCondition(t, func() bool {
		return coordinator.ActiveStatuses()["chat-1"] == readmodels.StatusWaitingForUser
	})

	if err := coordinator.RespondTool(context.Background(), ToolResponseCommand{
		ChatID:    "chat-1",
		ToolUseID: "tool-1",
		Result:    "approved",
	}); err != nil {
		t.Fatalf("RespondTool returned error: %v", err)
	}
	if turn.toolResponse.Result != "approved" {
		t.Fatalf("expected response forwarded to turn, got %#v", turn.toolResponse)
	}
}

type fakeStore struct {
	mu            sync.Mutex
	chats         map[string]readmodels.ChatRecord
	queued        map[string][]readmodels.QueuedChatMessage
	entries       map[string][]readmodels.TranscriptEntry
	sessionTokens map[string]string
	started       int
	finished      int
	cancelled     int
	failed        int
}

func newFakeStore() *fakeStore {
	return &fakeStore{
		chats: map[string]readmodels.ChatRecord{
			"chat-1": {
				ID:        "chat-1",
				ProjectID: "project-1",
				Title:     "New Chat",
				CreatedAt: 1,
				UpdatedAt: 1,
			},
		},
		queued:        map[string][]readmodels.QueuedChatMessage{},
		entries:       map[string][]readmodels.TranscriptEntry{},
		sessionTokens: map[string]string{},
	}
}

func (s *fakeStore) CreateChat(projectID string) (readmodels.ChatRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	chat := readmodels.ChatRecord{
		ID:        "chat-created",
		ProjectID: projectID,
		Title:     "New Chat",
		CreatedAt: 1,
		UpdatedAt: 1,
	}
	s.chats[chat.ID] = chat
	return chat, nil
}

func (s *fakeStore) RequireChat(chatID string) (readmodels.ChatRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	chat, ok := s.chats[chatID]
	if !ok {
		return readmodels.ChatRecord{}, errors.New("chat not found")
	}
	return chat, nil
}

func (s *fakeStore) SetChatProvider(chatID string, provider string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	chat := s.chats[chatID]
	chat.Provider = &provider
	s.chats[chatID] = chat
	return nil
}

func (s *fakeStore) SetPlanMode(chatID string, planMode bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	chat := s.chats[chatID]
	chat.PlanMode = planMode
	s.chats[chatID] = chat
	return nil
}

func (s *fakeStore) SetSessionToken(chatID string, sessionToken string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	chat := s.chats[chatID]
	chat.SessionToken = &sessionToken
	s.chats[chatID] = chat
	s.sessionTokens[chatID] = sessionToken
	return nil
}

func (s *fakeStore) AppendUserPrompt(string, string, []readmodels.ChatAttachment, bool) error {
	return nil
}

func (s *fakeStore) AppendTranscriptEntry(chatID string, entry readmodels.TranscriptEntry) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.entries[chatID] = append(s.entries[chatID], entry)
	return nil
}

func (s *fakeStore) RecordTurnStarted(string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.started++
	return nil
}

func (s *fakeStore) RecordTurnFinished(string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.finished++
	return nil
}

func (s *fakeStore) RecordTurnFailed(string, string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.failed++
	return nil
}

func (s *fakeStore) RecordTurnCancelled(string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.cancelled++
	return nil
}

func (s *fakeStore) EnqueueMessage(chatID string, message QueueMessageInput) (readmodels.QueuedChatMessage, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	queued := readmodels.QueuedChatMessage{
		ID:          "queued-" + message.Content,
		Content:     message.Content,
		Attachments: message.Attachments,
		CreatedAt:   2,
	}
	s.queued[chatID] = append(s.queued[chatID], queued)
	return queued, nil
}

func (s *fakeStore) GetQueuedMessages(chatID string) []readmodels.QueuedChatMessage {
	s.mu.Lock()
	defer s.mu.Unlock()

	return append([]readmodels.QueuedChatMessage(nil), s.queued[chatID]...)
}

func (s *fakeStore) GetQueuedMessage(chatID string, queuedMessageID string) (readmodels.QueuedChatMessage, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()

	for _, message := range s.queued[chatID] {
		if message.ID == queuedMessageID {
			return message, true
		}
	}
	return readmodels.QueuedChatMessage{}, false
}

func (s *fakeStore) RemoveQueuedMessage(chatID string, queuedMessageID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	existing := s.queued[chatID]
	next := existing[:0]
	for _, message := range existing {
		if message.ID != queuedMessageID {
			next = append(next, message)
		}
	}
	s.queued[chatID] = next
	return nil
}

func (s *fakeStore) UpdateQueuedMessage(chatID string, queuedMessageID string, content string) error {
	for index := range s.queued[chatID] {
		if s.queued[chatID][index].ID == queuedMessageID {
			s.queued[chatID][index].Content = content
			return nil
		}
	}
	return ErrQueuedNotFound
}

func (s *fakeStore) MarkQueuedMessageSteered(chatID string, queuedMessageID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for index := range s.queued[chatID] {
		if s.queued[chatID][index].ID == queuedMessageID {
			s.queued[chatID][index].DeliveryState = "steering"
			return nil
		}
	}
	return ErrQueuedNotFound
}

type fakeTurn struct {
	cancelled      bool
	toolResponse   ToolResponse
	events         chan TurnEvent
	steeredContent string
	steerErr       error
}

func (t *fakeTurn) Steer(_ context.Context, content string, _ []readmodels.ChatAttachment) error {
	t.steeredContent = content
	return t.steerErr
}

func (t *fakeTurn) Cancel() error {
	t.cancelled = true
	return nil
}

func (t *fakeTurn) RespondTool(_ context.Context, response ToolResponse) error {
	t.toolResponse = response
	return nil
}

func (t *fakeTurn) Events() <-chan TurnEvent {
	return t.events
}

func waitForCondition(t *testing.T, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("condition was not met before timeout")
}

func TestCoalesceLiveTranscriptEntryBuildsOneStreamingAssistantMessage(t *testing.T) {
	entries := coalesceLiveTranscriptEntry(nil, readmodels.TranscriptEntry{
		"kind": "assistant_text", "itemId": "msg-1", "textDelta": "still ", "status": "inProgress",
	})
	entries = coalesceLiveTranscriptEntry(entries, readmodels.TranscriptEntry{
		"kind": "assistant_text", "itemId": "msg-1", "textDelta": "working", "status": "inProgress",
	})
	if len(entries) != 1 || entries[0]["text"] != "still working" {
		t.Fatalf("expected one coalesced assistant message, got %#v", entries)
	}

	entries = coalesceLiveTranscriptEntry(entries, readmodels.TranscriptEntry{
		"kind": "assistant_text", "itemId": "msg-1", "text": "done", "status": "completed",
	})
	if len(entries) != 1 || entries[0]["text"] != "done" || entries[0]["status"] != "completed" {
		t.Fatalf("expected completion to replace the streamed text, got %#v", entries)
	}
}

func TestCoalesceLiveTranscriptEntryBuildsOneCommandOutput(t *testing.T) {
	entries := coalesceLiveTranscriptEntry(nil, readmodels.TranscriptEntry{
		"kind": "command_execution", "itemId": "cmd-1", "command": "go test ./...", "status": "inProgress",
	})
	entries = coalesceLiveTranscriptEntry(entries, readmodels.TranscriptEntry{
		"kind": "command_execution", "itemId": "cmd-1", "outputDelta": "ok ", "status": "inProgress",
	})
	entries = coalesceLiveTranscriptEntry(entries, readmodels.TranscriptEntry{
		"kind": "command_execution", "itemId": "cmd-1", "outputDelta": "done", "status": "inProgress",
	})
	if len(entries) != 1 || entries[0]["command"] != "go test ./..." || entries[0]["aggregatedOutput"] != "ok done" {
		t.Fatalf("expected one coalesced command, got %#v", entries)
	}
}
