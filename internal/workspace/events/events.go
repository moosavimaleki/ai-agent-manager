package events

import (
	"encoding/json"
	"time"
)

const Version = 2

const (
	StreamProjects       = "projects"
	StreamChats          = "chats"
	StreamMessages       = "messages"
	StreamQueuedMessages = "queued-messages"
	StreamTurns          = "turns"
)

func Streams() []string {
	return []string{
		StreamProjects,
		StreamChats,
		StreamMessages,
		StreamQueuedMessages,
		StreamTurns,
	}
}

const (
	TypeProjectOpened           = "project_opened"
	TypeProjectSidebarRenamed   = "project_sidebar_renamed"
	TypeProjectSidebarReordered = "project_sidebar_reordered"
	TypeProjectRemoved          = "project_removed"

	TypeChatCreated         = "chat_created"
	TypeChatRenamed         = "chat_renamed"
	TypeChatDeleted         = "chat_deleted"
	TypeChatArchived        = "chat_archived"
	TypeChatUnarchived      = "chat_unarchived"
	TypeChatPinned          = "chat_pinned"
	TypeChatPinnedReordered = "chat_pinned_reordered"
	TypeChatProviderSet     = "chat_provider_set"
	TypeChatPlanModeSet     = "chat_plan_mode_set"
	TypeChatReadStateSet    = "chat_read_state_set"
	TypeChatRuntimeSet      = "chat_runtime_set"

	TypeMessageAppended          = "message_appended"
	TypeChatRestoredToCheckpoint = "chat_restored_to_checkpoint"
	TypeQueuedMessageEnqueued    = "queued_message_enqueued"
	TypeQueuedMessageUpdated     = "queued_message_updated"
	TypeQueuedMessageSteered     = "queued_message_steered"
	TypeQueuedMessageRemoved     = "queued_message_removed"

	TypeTurnStarted                = "turn_started"
	TypeTurnFinished               = "turn_finished"
	TypeTurnFailed                 = "turn_failed"
	TypeTurnCancelled              = "turn_cancelled"
	TypeSessionTokenSet            = "session_token_set"
	TypePendingForkSessionTokenSet = "pending_fork_session_token_set"
)

type Event struct {
	V         int            `json:"v"`
	Type      string         `json:"type"`
	Timestamp int64          `json:"timestamp"`
	Fields    map[string]any `json:"-"`
}

func New(eventType string, data any) (Event, error) {
	fields, err := fieldsFromData(data)
	if err != nil {
		return Event{}, err
	}
	return Event{
		V:         Version,
		Type:      eventType,
		Timestamp: time.Now().UnixMilli(),
		Fields:    fields,
	}, nil
}

func NewAt(eventType string, timestamp int64, data any) (Event, error) {
	fields, err := fieldsFromData(data)
	if err != nil {
		return Event{}, err
	}
	return Event{
		V:         Version,
		Type:      eventType,
		Timestamp: timestamp,
		Fields:    fields,
	}, nil
}

func (e Event) DecodeData(target any) error {
	if len(e.Fields) == 0 {
		return nil
	}
	data, err := json.Marshal(e.Fields)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, target)
}

func (e Event) MarshalJSON() ([]byte, error) {
	payload := map[string]any{
		"v":         e.V,
		"type":      e.Type,
		"timestamp": e.Timestamp,
	}
	for key, value := range e.Fields {
		switch key {
		case "v", "type", "timestamp":
			continue
		default:
			payload[key] = value
		}
	}
	return json.Marshal(payload)
}

func (e *Event) UnmarshalJSON(data []byte) error {
	var payload map[string]any
	if err := json.Unmarshal(data, &payload); err != nil {
		return err
	}

	if raw, ok := payload["v"].(float64); ok {
		e.V = int(raw)
	}
	if raw, ok := payload["type"].(string); ok {
		e.Type = raw
	}
	if raw, ok := payload["timestamp"].(float64); ok {
		e.Timestamp = int64(raw)
	}

	delete(payload, "v")
	delete(payload, "type")
	delete(payload, "timestamp")
	e.Fields = payload
	return nil
}

func fieldsFromData(data any) (map[string]any, error) {
	if data == nil {
		return map[string]any{}, nil
	}
	raw, err := json.Marshal(data)
	if err != nil {
		return nil, err
	}
	var fields map[string]any
	if err := json.Unmarshal(raw, &fields); err != nil {
		return nil, err
	}
	return fields, nil
}
