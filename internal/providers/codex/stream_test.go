package codex

import (
	"encoding/json"
	"testing"

	codexrpc "abolqasem/internal/providers/codex/rpc"
)

func TestStreamNormalizerMapsCoreTurnTranscriptEvents(t *testing.T) {
	normalizer := NewStreamNormalizer()
	notifications := []codexrpc.Notification{
		notification("thread/started", map[string]any{
			"thread": map[string]any{"id": "thread-1"},
		}),
		notification("item/started", map[string]any{
			"threadId": "thread-1",
			"turnId":   "turn-1",
			"item": map[string]any{
				"type":    "commandExecution",
				"id":      "call-1",
				"command": "/bin/zsh -lc pwd",
				"status":  "inProgress",
			},
		}),
		notification("item/completed", map[string]any{
			"threadId": "thread-1",
			"turnId":   "turn-1",
			"item": map[string]any{
				"type":             "commandExecution",
				"id":               "call-1",
				"command":          "/bin/zsh -lc pwd",
				"status":           "completed",
				"aggregatedOutput": "/tmp/project\n",
				"exitCode":         0,
			},
		}),
		notification("item/completed", map[string]any{
			"threadId": "thread-1",
			"turnId":   "turn-1",
			"item": map[string]any{
				"type":  "agentMessage",
				"id":    "msg-1",
				"text":  "/tmp/project",
				"phase": "final_answer",
			},
		}),
		notification("turn/completed", map[string]any{
			"threadId": "thread-1",
			"turn": map[string]any{
				"id":     "turn-1",
				"status": "completed",
				"error":  nil,
			},
		}),
	}

	var events []HarnessEvent
	for _, item := range notifications {
		events = append(events, normalizer.HandleNotification(item)...)
	}
	if events[0].Type != "session_token" || events[0].SessionToken != "thread-1" {
		t.Fatalf("unexpected session token event: %#v", events[0])
	}
	var kinds []string
	for _, event := range events {
		if event.Type == "transcript" {
			kinds = append(kinds, event.Entry["kind"].(string))
		}
	}
	expected := []string{"command_execution", "turn_activity", "command_execution", "assistant_text", "result"}
	if !equalStringSlices(kinds, expected) {
		t.Fatalf("expected transcript kinds %#v, got %#v", expected, kinds)
	}
}

func TestStreamNormalizerEmitsModelChange(t *testing.T) {
	events := NewStreamNormalizer().HandleNotification(notification("turn/started", map[string]any{
		"turnId": "turn-1", "collaborationMode": map[string]any{"settings": map[string]any{"model": "gpt-5.6-sol", "reasoning_effort": "high"}},
	}))
	if len(events) != 2 || events[1].Entry["kind"] != "model_change" || events[1].Entry["reasoningEffort"] != "high" {
		t.Fatalf("unexpected model change events: %#v", events)
	}
}

func TestStreamNormalizerMapsTokenUsage(t *testing.T) {
	events := NewStreamNormalizer().HandleNotification(notification("thread/tokenUsage/updated", map[string]any{
		"threadId": "thread-usage",
		"turnId":   "turn-usage",
		"tokenUsage": map[string]any{
			"total": map[string]any{
				"inputTokens":           11833,
				"cachedInputTokens":     3456,
				"outputTokens":          6,
				"reasoningOutputTokens": 0,
				"totalTokens":           11839,
			},
			"last": map[string]any{
				"inputTokens":           120,
				"cachedInputTokens":     0,
				"outputTokens":          6,
				"reasoningOutputTokens": 0,
				"totalTokens":           126,
			},
			"modelContextWindow": 258400,
		},
	}))
	if len(events) != 1 || events[0].Type != "transcript" {
		t.Fatalf("unexpected events: %#v", events)
	}
	if events[0].Entry["kind"] != "context_window_updated" {
		t.Fatalf("unexpected entry: %#v", events[0].Entry)
	}
	usage := events[0].Entry["usage"].(map[string]any)
	if usage["usedTokens"] != float64(126) {
		t.Fatalf("expected used tokens 126, got %#v", usage["usedTokens"])
	}
	if usage["totalProcessedTokens"] != float64(11839) {
		t.Fatalf("expected total processed tokens, got %#v", usage["totalProcessedTokens"])
	}
	if usage["maxTokens"] != float64(258400) {
		t.Fatalf("expected max tokens, got %#v", usage["maxTokens"])
	}
	if usage["compactsAutomatically"] != true {
		t.Fatalf("expected automatic compaction flag, got %#v", usage["compactsAutomatically"])
	}
}

func TestStreamNormalizerMapsRateLimits(t *testing.T) {
	events := NewStreamNormalizer().HandleNotification(notification("account/rateLimits/updated", map[string]any{
		"rateLimits": map[string]any{
			"limitId": "codex",
			"credits": map[string]any{
				"hasCredits": true,
				"unlimited":  false,
				"balance":    "12.34",
			},
			"primary": map[string]any{
				"usedPercent":        42.5,
				"windowDurationMins": 300,
				"resetsAt":           1700000000,
			},
			"secondary": map[string]any{
				"usedPercent":        12,
				"windowDurationMins": 10080,
			},
		},
	}))
	if len(events) != 1 || events[0].Type != "transcript" {
		t.Fatalf("unexpected events: %#v", events)
	}
	if events[0].Entry["kind"] != "rate_limit_updated" {
		t.Fatalf("unexpected entry: %#v", events[0].Entry)
	}
	if _, ok := events[0].Entry["hidden"]; ok {
		t.Fatalf("expected visible entry, got %#v", events[0].Entry)
	}
	limits := events[0].Entry["rateLimits"].(map[string]any)
	credits := limits["credits"].(map[string]any)
	primary := limits["primary"].(map[string]any)
	secondary := limits["secondary"].(map[string]any)
	if credits["balance"] != "12.34" || credits["hasCredits"] != true {
		t.Fatalf("unexpected credits: %#v", credits)
	}
	if primary["usedPercent"] != float64(42.5) || primary["windowDurationMins"] != float64(300) {
		t.Fatalf("unexpected primary window: %#v", primary)
	}
	if secondary["usedPercent"] != float64(12) || secondary["windowDurationMins"] != float64(10080) {
		t.Fatalf("unexpected secondary window: %#v", secondary)
	}
	windows, ok := limits["windows"].([]map[string]any)
	if !ok || len(windows) != 2 {
		t.Fatalf("expected dynamic window list, got %#v", limits["windows"])
	}
}

func TestNormalizeRateLimitSnapshotPreservesAdditionalWindows(t *testing.T) {
	snapshot := normalizeRateLimitSnapshot(map[string]any{
		"primary": map[string]any{"usedPercent": 10, "windowDurationMins": 300},
		"windows": []any{
			map[string]any{"usedPercent": 10, "windowDurationMins": 300},
			map[string]any{"usedPercent": 45, "windowDurationMins": 1440},
		},
	})
	windows, ok := snapshot["windows"].([]map[string]any)
	if !ok || len(windows) != 2 || windows[1]["windowDurationMins"] != float64(1440) {
		t.Fatalf("additional rate limit windows were lost: %#v", snapshot)
	}
}

func TestStreamNormalizerMapsCompaction(t *testing.T) {
	events := NewStreamNormalizer().HandleNotification(notification("thread/compacted", map[string]any{
		"threadId": "thread-1",
		"turnId":   "turn-1",
	}))
	if len(events) != 1 || events[0].Entry["kind"] != "compact_boundary" {
		t.Fatalf("unexpected events: %#v", events)
	}
}

func TestStreamNormalizerMapsFileChanges(t *testing.T) {
	normalizer := NewStreamNormalizer()
	started := normalizer.HandleNotification(notification("item/started", map[string]any{
		"item": map[string]any{
			"type":    "fileChange",
			"id":      "file-1",
			"changes": []any{map[string]any{"path": "internal/server/main.go", "kind": "update"}},
		},
	}))
	if len(started) != 2 || started[0].Entry["kind"] != "file_change" || started[1].Entry["kind"] != "turn_activity" {
		t.Fatalf("unexpected started events: %#v", started)
	}
	if started[0].Entry["itemId"] != "file-1" || started[1].Entry["activity"] != "applying_changes" {
		t.Fatalf("unexpected file-change payload: %#v", started)
	}

	completed := normalizer.HandleNotification(notification("item/completed", map[string]any{
		"item": map[string]any{
			"type":    "fileChange",
			"id":      "file-1",
			"status":  "completed",
			"changes": []any{map[string]any{"path": "internal/server/main.go", "kind": "update"}},
		},
	}))
	if len(completed) != 1 || completed[0].Entry["kind"] != "file_change" || completed[0].Entry["itemId"] != "file-1" {
		t.Fatalf("unexpected completed events: %#v", completed)
	}
}

func TestStreamNormalizerMapsNativeDeltasAndTurnPlan(t *testing.T) {
	normalizer := NewStreamNormalizer()
	agentMessage := normalizer.HandleNotification(notification("item/agentMessage/delta", map[string]any{"itemId": "msg-1", "delta": "still working"}))
	if len(agentMessage) != 1 || agentMessage[0].Entry["kind"] != "assistant_text" || agentMessage[0].Entry["itemId"] != "msg-1" || agentMessage[0].Entry["textDelta"] != "still working" || agentMessage[0].Entry["status"] != "inProgress" {
		t.Fatalf("unexpected agent message delta: %#v", agentMessage)
	}
	command := normalizer.HandleNotification(notification("item/commandExecution/outputDelta", map[string]any{"itemId": "cmd-1", "delta": "hello\n"}))
	if len(command) != 1 || command[0].Entry["kind"] != "command_execution" || command[0].Entry["outputDelta"] != "hello\n" {
		t.Fatalf("unexpected command delta: %#v", command)
	}
	plan := normalizer.HandleNotification(notification("turn/plan/updated", map[string]any{
		"turnId": "turn-1", "explanation": "Ship it", "plan": []any{map[string]any{"step": "Test", "status": "inProgress"}},
	}))
	if len(plan) != 1 || plan[0].Entry["kind"] != "turn_plan" || plan[0].Entry["turnId"] != "turn-1" {
		t.Fatalf("unexpected plan: %#v", plan)
	}
}

func TestStreamNormalizerKeepsAgentMessageIDOnCompletion(t *testing.T) {
	events := NewStreamNormalizer().HandleNotification(notification("item/completed", map[string]any{
		"item": map[string]any{"type": "agentMessage", "id": "msg-1", "text": "done"},
	}))
	if len(events) != 1 || events[0].Entry["kind"] != "assistant_text" || events[0].Entry["itemId"] != "msg-1" || events[0].Entry["text"] != "done" || events[0].Entry["status"] != "completed" {
		t.Fatalf("unexpected completed agent message: %#v", events)
	}
}

func TestStreamNormalizerMapsPlanToPlanCard(t *testing.T) {
	events := NewStreamNormalizer().HandleNotification(notification("item/completed", map[string]any{
		"item": map[string]any{"type": "plan", "id": "plan-1", "text": "1. Inspect\n2. Implement"},
	}))
	if len(events) != 1 || events[0].Entry["kind"] != "tool_call" {
		t.Fatalf("unexpected plan events: %#v", events)
	}
	tool := events[0].Entry["tool"].(map[string]any)
	input := tool["input"].(map[string]any)
	if tool["toolKind"] != "exit_plan_mode" || input["plan"] != "1. Inspect\n2. Implement" {
		t.Fatalf("unexpected plan card payload: %#v", tool)
	}
}

func TestStreamNormalizerMapsMCPToolCalls(t *testing.T) {
	normalizer := NewStreamNormalizer()
	started := normalizer.HandleNotification(notification("item/started", map[string]any{
		"item": map[string]any{
			"type":      "mcpToolCall",
			"id":        "mcp-1",
			"server":    "filesystem",
			"tool":      "read_file",
			"arguments": map[string]any{"path": "/tmp/report.txt"},
			"status":    "inProgress",
		},
	}))
	if len(started) != 2 || started[0].Entry["kind"] != "tool_call" || started[1].Entry["kind"] != "turn_activity" {
		t.Fatalf("unexpected MCP started events: %#v", started)
	}
	tool := started[0].Entry["tool"].(map[string]any)
	if tool["toolKind"] != "mcp_generic" || tool["toolName"] != "mcp__filesystem__read_file" || tool["toolId"] != "mcp-1" {
		t.Fatalf("unexpected MCP tool payload: %#v", tool)
	}

	completed := normalizer.HandleNotification(notification("item/completed", map[string]any{
		"item": map[string]any{
			"type":   "mcpToolCall",
			"id":     "mcp-1",
			"status": "completed",
			"result": map[string]any{"content": "hello"},
		},
	}))
	if len(completed) != 1 || completed[0].Entry["kind"] != "tool_result" || completed[0].Entry["toolId"] != "mcp-1" {
		t.Fatalf("unexpected MCP completed events: %#v", completed)
	}
}

func notification(method string, params any) codexrpc.Notification {
	data, err := json.Marshal(params)
	if err != nil {
		panic(err)
	}
	return codexrpc.Notification{Method: method, Params: data}
}

func equalStringSlices(left []string, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}
